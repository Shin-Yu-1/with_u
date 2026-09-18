import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { wrap } from "./tui";

assert.deepEqual(wrap("한글 👩‍💻e\u0301\n끝", 4), ["한글", " 👩‍💻e\u0301", "끝"]);
assert.deepEqual(wrap("\x1b[31mred\x1b[0m\x1b]52;c;hidden\x07\r!", 10), ["red!"]);
assert.deepEqual(wrap("한a", 1), ["a"]);

// Run the real CLI with isolated storage and SDKs that block until cancelled; no API calls.
const scratch = mkdtempSync(join(tmpdir(), "agentsession-test-"));
const preload = join(scratch, "preload.ts");
const entry = join(import.meta.dir, "agentsession.ts");
writeFileSync(preload, `
import { mock, spyOn } from "bun:test";
import { writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
spyOn(os, "homedir").mockReturnValue(${JSON.stringify(scratch)});
async function* events(signal, kind, prompt, options = {}) {
  appendFileSync(${JSON.stringify(scratch)} + "/calls.jsonl", JSON.stringify({ kind, prompt, model: options.model, resume: options.resume, system: options.systemPrompt }) + "\\n");
  prompt = prompt.slice(prompt.lastIndexOf("[user →"));
  const scenario = prompt.match(/FAILOVER_(claude|codex)_(THROW|RESULT|EVENT|EMPTY|PARTIAL|AUTH|CONTEXT)/);
  if (scenario && scenario[1] === kind) {
    const failure = scenario[2];
    if (failure === "EMPTY") return;
    if (failure === "THROW") throw new Error("You've hit your weekly limit · resets Sep 20 at 10pm (Asia/Seoul)");
    if (failure === "AUTH") throw new Error("authentication token expired");
    if (failure === "CONTEXT") throw new Error("context window exceeded; session expired");
    if (failure === "PARTIAL") yield { type: "item.completed", item: { type: "agent_message", text: "incomplete answer" } };
    yield kind === "claude"
      ? failure === "RESULT"
        ? { type: "result", subtype: "success", is_error: true, result: "weekly limit reached", session_id: "failed-native" }
        : { type: "result", subtype: "error_during_execution", errors: ["session expired"], session_id: "failed-native" }
      : failure === "EVENT"
        ? { type: "error", message: "session expired" }
        : { type: "turn.failed", error: { message: "token limit exceeded" } };
    return;
  }
  if (scenario) {
    yield kind === "codex"
      ? { type: "item.completed", item: { type: "agent_message", text: "fallback done" } }
      : { type: "result", subtype: "success", result: "fallback done", session_id: "test-claude" };
    return;
  }
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
mock.module(${JSON.stringify(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))}, () => ({ query: ({ prompt, options }) => events(options.abortController?.signal, "claude", prompt, options) }));
mock.module(${JSON.stringify(import.meta.resolve("@openai/codex-sdk"))}, () => ({ Codex: class {
  startThread(settings = {}) { return { id: "test-codex", runStreamed: async (prompt, options) => ({ events: events(options?.signal, "codex", prompt, settings) }) }; }
  resumeThread(id, settings) { return this.startThread({ ...settings, resume: id }); }
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
  const calls = () => readFileSync(join(scratch, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const kind of ["claude", "codex"]) {
    for (const failure of ["THROW", "RESULT", "EVENT", "EMPTY", "PARTIAL", "AUTH", "CONTEXT"]) {
      if (kind === "claude" && failure === "PARTIAL") continue;
      const sid = seed();
      const path = join(scratch, ".agent-sessions", sid, "session.json");
      const other = kind === "claude" ? "codex" : "claude";
      const s = JSON.parse(readFileSync(path, "utf8"));
      s.agents = {
        pm: { kind, model: "primary-model", role: "ROLE_KEEP", native: "old-primary", lastSeq: 1 },
        helper: { kind: other, model: "backup-model", role: "OTHER_ROLE", native: "unrelated-native", lastSeq: 99 },
      };
      writeFileSync(path, JSON.stringify(s));
      writeFileSync(join(scratch, ".agent-sessions", sid, "transcript.jsonl"), JSON.stringify({ seq: 1, ts: new Date().toISOString(), from: "pm", to: "user", text: "earlier decision" }) + "\n");
      writeFileSync(join(scratch, "calls.jsonl"), "");
      const result = invoke("run", sid, "pm", `FAILOVER_${kind}_${failure}`);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes("[pm] fallback done"), result.stdout);
      const attempts = calls();
      assert.deepEqual(attempts.map(c => c.kind), [kind, other]);
      assert.equal(attempts[1].resume, undefined, "never reuse another agent/provider's native session");
      assert.equal(attempts[1].model, "backup-model");
      assert.ok(JSON.stringify(attempts[1]).includes("ROLE_KEEP"));
      assert.ok(!JSON.stringify(attempts[1]).includes("OTHER_ROLE"));
      assert.ok(attempts[1].prompt.includes("earlier decision"), "handoff includes this role's earlier answers");
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(saved.agents.pm.kind, other);
      assert.equal(saved.agents.pm.role, "ROLE_KEEP");
      assert.deepEqual(saved.agents.helper, s.agents.helper);
      assert.ok(!ok("show", sid).includes("incomplete answer"));
      writeFileSync(join(scratch, "calls.jsonl"), "");
      assert.ok(ok("run", sid, "pm", "TEST_SUCCESS").includes("done"));
      assert.deepEqual(calls().map(c => c.kind), [other], "successful fallback is preferred across CLI invocations");
      assert.equal(calls()[0].resume, `test-${other}`);
      ok("stop", sid);
    }
  }
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
    assert.ok(failure.stderr.includes("claude") && failure.stderr.includes("codex"), "both causes must be reported");
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
  for (const mode of ["full", "ctrlc", "eof", "sigterm", "external", "plain", "dumb"]) {
    const terminal = seed();
    writeFileSync(join(scratch, ".agent-sessions", terminal, "transcript.jsonl"), JSON.stringify({ seq: 1, ts: new Date().toISOString(), from: "user", to: "codex", text: Array.from({ length: 35 }, (_, i) => `history-${i}`).join("\n") }) + "\n");
    const tui = spawnSync("python3", [join(import.meta.dir, "tui-pty.test.py"), process.execPath, ...cli("chat", terminal), ...(mode === "plain" ? ["--plain"] : [])], {
      encoding: "utf8", timeout: 15000, env: { ...process.env, TUI_TEST_MODE: mode },
    });
    assert.equal(tui.status, 0, tui.stderr || tui.error?.message);
    if (mode === "full") {
      assert.ok(existsSync(join(scratch, "aborted-codex" + terminal)), "TUI quit must cancel the SDK");
      const terminalLog = ok("show", terminal);
      assert.ok(terminalLog.includes("한글 👩‍💻"));
      assert.ok(!terminalLog.includes("missing"), "invalid recipients must not enter shared history");
    }
    assert.ok(!ok("list").includes(terminal));
    console.log(tui.stdout.trim());
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
