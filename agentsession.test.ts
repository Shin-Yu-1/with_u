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
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
mock.module("node:os", () => ({ homedir: () => ${JSON.stringify(scratch)} }));
async function* events(signal, kind) {
  writeFileSync(${JSON.stringify(scratch)} + "/started-" + kind, "yes");
  if (!signal) await new Promise(() => {});
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
  writeFileSync(${JSON.stringify(scratch)} + "/aborted-" + kind, "yes");
  signal.throwIfAborted();
}
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: ({ options }) => events(options.abortController?.signal, "claude") }));
mock.module("@openai/codex-sdk", () => ({ Codex: class {
  startThread() { return { runStreamed: async (_, options) => ({ events: events(options?.signal, "codex") }) }; }
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
const waitFor = async (predicate: () => boolean, message: string) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
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

  for (const ending of ["/quit", "/q", "EOF", "SIGINT", "SIGTERM", "stop"]) {
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
    const active = seed();
    const { child, output } = launch("run", active, kind, "hello");
    await waitFor(() => existsSync(join(scratch, "started-" + kind)), `${kind} did not start: ${output()}`);
    ok("stop", active);
    await waitFor(() => child.exitCode !== null, `${kind} did not exit: ${output()}`);
    assert.equal(child.exitCode, 0, output());
    assert.ok(existsSync(join(scratch, "aborted-" + kind)), `${kind} SDK was not cancelled`);
    assert.ok(!ok("list").includes(active));
  }
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
