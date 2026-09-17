#!/usr/bin/env bun
/**
 * agentsession — one shared session id, several agents (Claude via Claude Agent SDK,
 * Codex via Codex SDK). All turns land in ~/.agent-sessions/<sid>/transcript.jsonl;
 * each agent keeps its own native session/thread underneath and is shown what the
 * other participants said since its last turn.
 *
 *   agentsession new  [--cwd DIR] [--agents claude,codex] [--default claude]
 *   agentsession run  <sid> <agent> <message...>
 *   agentsession chat <sid>              # REPL: "@codex ...", "@claude ...", "@all ...", plain -> default
 *   agentsession show <sid> [n]
 *   agentsession list
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";

const ROOT = join(process.env.HOME ?? "~", ".agent-sessions");
const MAX_HOPS = 4; // agent→agent auto-forward limit per user message

type Kind = "claude" | "codex";
interface AgentState { kind: Kind; model?: string; effort?: string; role?: string; native?: string; lastSeq: number }
const ROLES_FILE = join(process.env.HOME ?? "~", ".agentsession", "roles.json");
interface Session { sid: string; cwd: string; created: string; default: string; agents: Record<string, AgentState> }
interface Entry { seq: number; ts: string; from: string; to: string; text: string }

// ---------- store ----------
const dir = (sid: string) => join(ROOT, sid);
const load = (sid: string): Session => {
  const p = join(dir(sid), "session.json");
  if (!existsSync(p)) throw new Error(`no such session: ${sid}`);
  return JSON.parse(readFileSync(p, "utf8"));
};
const save = (s: Session) => writeFileSync(join(dir(s.sid), "session.json"), JSON.stringify(s, null, 2));
const transcript = (sid: string): Entry[] => {
  const p = join(dir(sid), "transcript.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const append = (sid: string, e: Omit<Entry, "seq" | "ts">): Entry => {
  const seq = transcript(sid).length + 1; // ponytail: no cross-process lock; one chat process per sid
  const entry: Entry = { seq, ts: new Date().toISOString(), ...e };
  appendFileSync(join(dir(sid), "transcript.jsonl"), JSON.stringify(entry) + "\n");
  return entry;
};

// ---------- prompts ----------
const systemPrompt = (s: Session, name: string) => {
  const others = Object.keys(s.agents).filter((a) => a !== name).map((a) => `${a}(${s.agents[a].model ?? s.agents[a].kind})`).join(", ");
  const role = s.agents[name].role ? `\n${s.agents[name].role}\n` : "";
  return `너는 공유 세션 ${s.sid}의 참여자 "${name}"이다. 다른 참여자: ${others}. 사용자(user)도 있다.${role}
작업 디렉터리: ${s.cwd}. 모든 참여자의 발언은 하나의 공유 트랜스크립트에 기록되고, 네 차례가 오면 네 마지막 턴 이후의 발언을 먼저 보여준다.
규칙:
- 다른 참여자에게 직접 말하거나 일을 넘기려면 줄 맨 앞에 "@이름: "을 붙인다 (예: "@${others.split(", ")[0] ?? "codex"}: 이 diff 검토해줘"). 오케스트레이터가 그 줄을 전달한다.
- 사용자에게 하는 말은 접두어 없이 쓴다.
- 같은 파일을 다른 참여자가 막 수정했다고 보이면 먼저 읽고 나서 고친다. 이미 끝난 일은 반복하지 않는다.
- 답은 간결하고 구체적으로.`;
};

const buildPrompt = (s: Session, name: string, entries: Entry[], msg: Entry) => {
  const st = s.agents[name];
  const missed = entries.filter((e) => e.seq > st.lastSeq && e.from !== name && e.seq !== msg.seq);
  const ctx = missed.length
    ? "네 마지막 턴 이후 다른 참여자의 발언:\n" + missed.map((e) => `[${e.from} → ${e.to}] ${e.text}`).join("\n\n") + "\n\n"
    : "";
  return `${ctx}[${msg.from} → ${name}] ${msg.text}`;
};

// ---------- runners ----------
async function runClaude(s: Session, name: string, prompt: string): Promise<string> {
  const st = s.agents[name];
  let text = "";
  const opts: Record<string, unknown> = {
    cwd: s.cwd,
    permissionMode: "acceptEdits",
    ...(st.model ? { model: st.model } : {}),
    ...(st.native ? { resume: st.native } : { systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt(s, name) } }),
  };
  for await (const m of query({ prompt, options: opts as any })) {
    if (m.type === "assistant") {
      for (const b of (m as any).message?.content ?? []) {
        if (b.type === "tool_use") progress(name, `${b.name} ${brief(b.input)}`);
        else if (b.type === "text" && b.text?.trim()) progress(name, `💬 ${b.text.trim().slice(0, 100).replace(/\n/g, " ")}`);
      }
    }
    if (m.type === "result") {
      st.native = m.session_id;
      text = m.subtype === "success" ? m.result : `(claude ${m.subtype})`;
    }
  }
  return text;
}

// live progress line while an agent works (tool name + a short arg), so a long turn never looks hung
const progress = (who: string, what: string) => process.stdout.write(`   ${who} · ${what.slice(0, 110)}\n`);
const brief = (input: any) => String(input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? input?.description ?? "").slice(0, 80);

async function runCodex(s: Session, name: string, prompt: string): Promise<string> {
  const st = s.agents[name];
  const codex = new Codex();
  const topts = {
    workingDirectory: s.cwd, skipGitRepoCheck: true, sandboxMode: "workspace-write",
    ...(st.model ? { model: st.model } : {}), ...(st.effort ? { modelReasoningEffort: st.effort } : {}),
  } as any;
  const thread = st.native ? codex.resumeThread(st.native, topts) : codex.startThread(topts);
  const full = st.native ? prompt : `${systemPrompt(s, name)}\n\n${prompt}`;
  const { events } = await thread.runStreamed(full);
  let final = "";
  for await (const ev of events as AsyncGenerator<any>) {
    if (ev.type === "item.started" && ev.item?.type === "command_execution") progress(name, `Bash ${String(ev.item.command ?? "").slice(0, 80)}`);
    else if (ev.type === "item.completed" && ev.item?.type === "file_change") progress(name, `Edit ${(ev.item.changes ?? []).map((c: any) => c.path).join(", ").slice(0, 80)}`);
    else if (ev.type === "item.completed" && ev.item?.type === "agent_message") final = ev.item.text ?? final;
    else if (ev.type === "turn.failed" || ev.type === "error") final ||= `(codex error: ${ev.error?.message ?? ev.message ?? "unknown"})`;
  }
  st.native = thread.id ?? st.native;
  return final || "(codex: no response)";
}

const RUN: Record<Kind, typeof runClaude> = { claude: runClaude, codex: runCodex };

// ---------- turn engine ----------
async function turn(s: Session, to: string, msg: Entry, hops = 0): Promise<void> {
  const st = s.agents[to];
  if (!st) { console.error(`unknown agent: ${to}`); return; }
  const entries = transcript(s.sid);
  const prompt = buildPrompt(s, to, entries, msg);
  process.stdout.write(`\n── ${to} 생각 중…\n`);
  const reply = await RUN[st.kind](s, to, prompt);
  st.lastSeq = transcript(s.sid).length; // everything up to now has been shown to it
  save(s);
  const out = append(s.sid, { from: to, to: "user", text: reply });
  console.log(`\n[${to}] ${reply}\n`);
  // agent → agent forwarding: lines starting with "@name:"
  if (hops >= MAX_HOPS) return;
  const re = /^@([\w-]+):\s*(.+)$/gm;
  for (const m of reply.matchAll(re)) {
    const [, target, text] = m;
    if (s.agents[target] && target !== to) {
      const fwd = append(s.sid, { from: to, to: target, text });
      out.to = target;
      await turn(s, target, fwd, hops + 1);
    }
  }
}

async function say(s: Session, to: string, text: string) {
  const targets = to === "all" ? Object.keys(s.agents) : [to];
  for (const t of targets) {
    const e = append(s.sid, { from: "user", to: t, text });
    await turn(s, t, e);
  }
}

// ---------- commands ----------
function cmdNew(args: string[]) {
  const get = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const cwd = get("--cwd", process.cwd());
  const s: Session = { sid: randomUUID(), cwd, created: new Date().toISOString(), default: "", agents: {} };
  if (args.includes("--agents")) {
    // ad-hoc: name[:kind[:model]] , e.g. "pm:claude:opus,dev:codex:gpt-5.6-terra"
    for (const spec of get("--agents", "").split(",")) {
      const [n, k, model] = spec.split(":");
      s.agents[n] = { kind: (k ?? (n.startsWith("codex") ? "codex" : "claude")) as Kind, ...(model ? { model } : {}), lastSeq: 0 };
    }
    s.default = get("--default", Object.keys(s.agents)[0]);
  } else {
    const roles = JSON.parse(readFileSync(ROLES_FILE, "utf8"));
    const team = roles[get("--team", "default")];
    if (!team) { console.error(`no such team in ${ROLES_FILE}`); process.exit(2); }
    for (const [n, a] of Object.entries<any>(team.agents))
      s.agents[n] = { kind: a.kind, model: a.model, effort: a.effort, role: String(a.role ?? "").replace("$PONYTAIL", roles._ponytail ?? "").replace("$ECC_CLAUDE", roles._ecc_claude ?? "").replace("$ECC_CODEX", roles._ecc_codex ?? ""), lastSeq: 0 };
    s.default = get("--default", team.default ?? Object.keys(s.agents)[0]);
  }
  mkdirSync(dir(s.sid), { recursive: true });
  save(s);
  console.error(`agents: ${Object.entries(s.agents).map(([n, a]) => `${n}=${a.model ?? a.kind}`).join("  ")}  default=${s.default}`);
  console.log(s.sid);
}

async function cmdRun([sid, to, ...rest]: string[]) {
  const s = load(sid);
  await say(s, to, rest.join(" "));
}

function cmdShow([sid, n]: string[]) {
  const s = load(sid);
  const es = transcript(sid).slice(-(Number(n) || 50));
  console.log(`session ${sid}  cwd=${s.cwd}  agents=${Object.keys(s.agents).join(",")}`);
  for (const e of es) console.log(`\n#${e.seq} ${e.ts.slice(11, 19)} ${e.from} → ${e.to}\n${e.text}`);
}

function cmdList() {
  if (!existsSync(ROOT)) return;
  for (const d of readdirSync(ROOT)) {
    const p = join(ROOT, d, "session.json");
    if (!existsSync(p)) continue;
    const s: Session = JSON.parse(readFileSync(p, "utf8"));
    console.log(`${s.sid}  ${s.created.slice(0, 16)}  ${Object.keys(s.agents).join(",")}  ${s.cwd}`);
  }
}

// newest session whose cwd is the current directory, else undefined
function findForCwd(cwd: string): string | undefined {
  if (!existsSync(ROOT)) return;
  const hits = readdirSync(ROOT)
    .map((d) => join(ROOT, d, "session.json")).filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, "utf8")) as Session).filter((s) => s.cwd === cwd)
    .sort((a, b) => b.created.localeCompare(a.created));
  return hits[0]?.sid;
}

// `agentsession` with no args: resume this directory's latest shared session or start a team, then chat
async function cmdAuto() {
  let sid = findForCwd(process.cwd());
  if (sid) console.log(`이 디렉터리의 공유 세션을 이어갑니다: ${sid}`);
  else { console.log("이 디렉터리에 공유 세션이 없어 기본 팀을 만듭니다."); cmdNew([]); sid = findForCwd(process.cwd()); }
  await cmdChat([sid!]);
}

async function cmdChat([sid]: string[]) {
  if (!sid) return cmdAuto();
  const s = load(sid);
  console.log(`공유 세션 ${sid} — 참여자: ${Object.entries(s.agents).map(([n, a]) => `${n}(${a.model ?? a.kind})`).join(", ")} (기본: ${s.default})`);
  console.log(`입력: "@codex ...", "@claude ...", "@all ...", 그냥 쓰면 ${s.default}에게. /quit 종료`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise<string>((r) => rl.question("you> ", r));
  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/quit" || line === "/q") break;
    const m = line.match(/^@([\w-]+)\s+([\s\S]+)$/);
    const [to, text] = m ? [m[1], m[2]] : [s.default, line];
    try { await say(s, to, text); } catch (e) { console.error(`error: ${(e as Error).message}`); }
  }
  rl.close();
}

const [cmd, ...args] = process.argv.slice(2);
const cmds: Record<string, (a: string[]) => unknown> = { new: cmdNew, run: cmdRun, chat: cmdChat, show: cmdShow, list: cmdList, current: () => console.log(findForCwd(process.cwd()) ?? ""),
  // Claude Code SessionStart hook: tell the user this folder's team session (valid JSON, nothing if none)
  hook: () => { const sid = findForCwd(process.cwd()); if (sid) console.log(JSON.stringify({ systemMessage: `이 폴더의 공유 팀 세션: ${sid} → 터미널에서 'agentsession' (인자 없이)로 이어가기. 이 Claude 세션에서 팀원에게 시키려면: agentsession run ${sid} <agent> "<메시지>"` })); } };
if (!cmd) await cmdAuto();
else if (!cmds[cmd]) { console.error("usage: agentsession [new|run|chat|show|list|current]  — 인자 없이 실행하면 현재 폴더 세션 이어가기/생성 후 chat"); process.exit(2); }
else await cmds[cmd](args);
