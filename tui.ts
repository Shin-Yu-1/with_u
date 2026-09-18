import * as readline from "node:readline";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

// Treat transcript/tool output as text, never as terminal control sequences.
const clean = (text: string) => stripVTControlCharacters(text).replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function wrap(text: string, width: number): string[] {
  const lines = [""];
  let used = 0;
  for (const { segment } of segments.segment(clean(text))) {
    if (segment === "\n") { lines.push(""); used = 0; continue; }
    const size = Bun.stringWidth(segment);
    if (size > width) continue;
    if (used + size > width) { lines.push(""); used = 0; }
    lines[lines.length - 1] += segment;
    used += size;
  }
  return lines;
}

export class ChatTui {
  readonly input: readline.Interface;
  private messages: string[];
  private lines: string[] = [];
  private width = 0;
  private offset = 0;
  private status = "대기 중";
  private closed = false;
  private wasRaw = process.stdin.isRaw;

  constructor(private title: string, private roster: string, history: string[]) {
    this.messages = history;
    // Readline owns editing/history; its output is rendered in the fixed input row.
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    this.input = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    this.input.setPrompt("");
    process.stdout.write("\x1b[?1049h");
    process.stdin.on("keypress", this.keypress);
    process.stdout.on("resize", this.render);
    this.input.once("close", this.restore);
    this.render();
  }

  write(text: string) {
    this.messages.push(text);
    this.width = 0;
    this.offset = 0;
    this.render();
  }

  setStatus(text: string) {
    this.status = text;
    this.render();
  }

  close() { this.input.close(); }

  private keypress = (_text: string, key: readline.Key) => {
    const page = Math.max(1, (process.stdout.rows || 24) - 7);
    if (key.name === "pageup") this.offset += page;
    if (key.name === "pagedown") this.offset = Math.max(0, this.offset - page);
    // Readline finishes updating its cursor before the frame is drawn.
    queueMicrotask(this.render);
  };

  private render = () => {
    if (this.closed) return;
    const cols = Math.max(2, process.stdout.columns || 80);
    const rows = Math.max(1, process.stdout.rows || 24);
    const width = cols - 1;
    const fit = (text: string) => wrap(text, width)[0];
    if (this.width !== width) {
      // ponytail: rewrap history on messages/resizes; virtualize if very long sessions lag.
      this.lines = this.messages.flatMap(message => [...wrap(message, width), ""]);
      this.width = width;
    }
    const height = Math.max(0, rows - 7);
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - height));
    const end = this.lines.length - this.offset;
    const body = this.lines.slice(Math.max(0, end - height), end);
    while (body.length < height) body.push("");
    const before = clean(this.input.line.slice(0, this.input.cursor));
    const inputWidth = Math.max(1, width - 5);
    const inputRows = wrap(before, inputWidth);
    const tail = inputRows[inputRows.length - 1];
    const input = fit("you> " + tail + clean(this.input.line.slice(this.input.cursor)));
    const rule = "─".repeat(width);
    const frame = [fit(this.title), fit(this.roster), rule, ...body,
      fit(this.status + (this.offset ? " · 이전 대화" : "")), rule,
      fit("@이름 / @all · PgUp/PgDn 대화 · /quit 또는 Ctrl+C 종료"), input];
    const visible = rows >= 7 ? frame : [fit("창을 키우세요 · Ctrl+C 종료"), input].slice(-rows);
    const cursor = Math.min(width, 5 + Bun.stringWidth(tail)) + 1;
    process.stdout.write("\x1b[?25l\x1b[H" + visible.map(line => line + "\x1b[K").join("\r\n")
      + `\x1b[J\x1b[${visible.length};${cursor}H\x1b[?25h`);
  };

  private restore = () => {
    this.closed = true;
    process.stdin.off("keypress", this.keypress);
    process.stdout.off("resize", this.render);
    process.stdin.setRawMode(Boolean(this.wasRaw));
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
}
