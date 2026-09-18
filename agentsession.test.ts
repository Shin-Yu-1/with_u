import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Run the real CLI with isolated storage and SDKs that block until cancelled; no API calls.
const scratch = mkdtempSync(join(tmpdir(), "agentsession-test-"));
const preload = join(scratch, "preload.ts");
const entry = join(import.meta.dir, "agentsession.ts");
writeFileSync(preload, `
import { mock, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import os from "node:os";
spyOn(os, "homedir").mockReturnValue(${JSON.stringify(scratch)});
async function* events(signal, kind, prompt) {
  if (prompt.includes("TEST_SUCCESS")) {
    yield kind === "codex"
      ? { type: "item.completed", item: { type: "agent_message", text: "done" } }
      : { type: "result", subtype: "success", result: "done", session_id: "test-native" };
    return;
  }
  if (prompt.includes("TEST_FAILURE")) throw new Error("test SDK failure");
  const sid = process.argv[3];
  writeFileSync(${JSON.stringify(scratch)} + "/started-" + kind + sid, "yes");
  if (!signal) await new Promise(() => {});
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  writeFileSync(${JSON.stringify(scratch)} + "/aborted-" + kind + sid, "yes");
  signal.throwIfAborted();
}
mock.module(${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))}, () => ({ query: ({ prompt, options }) => events(options.abortController?.signal, "claude", prompt) }));
mock.module(${JSON.stringify(import.meta.resolve("@openai/codex-sdk"))}, () => ({ Codex: class {
  startThread() { return { runStreamed: async (prompt, options) => ({ events: events(options?.signal, "codex", prompt) }) }; }
} }));
`);
const cli = (...args: string[]) => ["--preload", preload, entry, ...args];
const invoke = (...args: string[]) => spawnSync(process.execPath, cli(...args), { encoding: "utf8", timeout: 3000 });
const ok = (...args: string[]) => {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};
const seed = () => {
  const sid = randomUUID();
  const folder = join(scratch, ".agent-sessions", sid);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "session.json"), JSON.stringify({
    sid, cwd: process.cwd(), created: new Date().toISOString(), default: "codex",
    agents: { codex: { kind: "codex", lastSeq: 0 }, claude: { kind: "claude", lastSeq: 0 } },
  }));
  writeFileSync(join(folder, "transcript.jsonl"), "");
  return sid;
};
const children: ReturnType<typeof spawn>[] = [];
const launch = (...args: string[]) => {
  const child = spawn(process.execPath, cli(...args), { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  return { child, output: () => output };
};
const waitFor = async (predicate: () => boolean, message: string | (() => string)) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, typeof message === "function" ? message() : message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

try {
  const sid = seed();
  ok("stop", sid); // RED on the original CLI: stop is not a command.
  assert.ok(!ok("list").includes(sid));
  assert.equal(ok("current"), "");
  assert.equal(ok("hook"), "");
  assert.ok(ok("show", sid).includes(sid));
  ok("stop", sid); // Idempotent, with history preserved.
  assert.notEqual(invoke("chat", sid).status, 0);
  assert.notEqual(invoke("run", sid, "codex", "hello").status, 0);
  for (const invalid of ["", "..", "../outside", randomUUID()]) {
    assert.notEqual(invoke("stop", invalid).status, 0);
  }
  assert.equal(readFileSync(join(scratch, ".agent-sessions", sid, "transcript.jsonl"), "utf8"), "");

  for (const ending of ["/quit", "/q", "EOF", "SIGINT", "SIGTERM", "SIGHUP", "stop"]) {
    const active = seed();
    const { child, output } = launch("chat", active);
    await waitFor(() => output().includes("you>"), output());
    assert.ok(ok("list").includes(active));
    assert.equal(ok("current"), active);
    if (ending === "stop") ok("stop", active);
    else if (ending === "EOF") child.stdin!.end();
    else if (ending.startsWith("SIG")) child.kill(ending as NodeJS.Signals);
    else child.stdin!.write(ending + "\n");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, `chat did not exit: ${ending} ${output()}`);
    assert.equal(child.exitCode, 0, output());
    assert.ok(!ok("list").includes(active), `still listed after ${ending}`);
    assert.equal(ok("current"), "");
  }

  for (const kind of ["codex", "claude"]) {
    const completed = seed();
    assert.ok(ok("run", completed, kind, "TEST_SUCCESS").includes("done"));
    assert.ok(ok("list").includes(completed), "a completed single turn must keep the shared session reusable");
    assert.ok(ok("show", completed).includes("done"));
    ok("stop", completed);
    const failed = seed();
    const failure = invoke("run", failed, kind, "TEST_FAILURE");
    assert.equal(failure.status, 1);
    assert.ok(failure.stderr.includes("test SDK failure"));
    ok("stop", failed);
  }

  for (const [mode, kind, ending] of [["run", "codex", "stop"], ["run", "claude", "stop"], ["chat", "codex", "stop"], ["chat", "claude", "SIGINT"]]) {
    const active = seed();
    const { child, output } = launch(mode, active, ...(mode === "run" ? [kind, "hello"] : []));
    if (mode === "chat") {
      await waitFor(() => output().includes("you>"), output);
      child.stdin!.write(`@${kind} hello\n`);
    }
    await waitFor(() => existsSync(join(scratch, "started-" + kind + active)), () => `${kind} did not start: ${output()}`);
    if (ending === "stop") ok("stop", active);
    else child.kill("SIGINT");
    await waitFor(() => child.exitCode !== null, () => `${kind} did not exit: ${output()}`);
    assert.equal(child.exitCode, 0, output());
    assert.ok(existsSync(join(scratch, "aborted-" + kind + active)), `${kind} SDK was not cancelled`);
    assert.ok(!ok("list").includes(active));
  }
  const kept = seed();
  const removed = seed();
  ok("stop", removed);
  assert.ok(ok("list").includes(kept), "stopping one session must leave other sessions alone");
  assert.equal(ok("current"), kept);
  console.log("session lifecycle checks passed (stop, history, validation, quit, EOF, signals, both SDK cancellations)");
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("close", resolve));
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
