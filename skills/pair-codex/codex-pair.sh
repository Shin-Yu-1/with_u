#!/usr/bin/env bash
# codex-pair.sh [--write|--reset] "<message>"   (or message on stdin)
# Keeps ONE persistent Codex thread per Claude Code session so Codex acts as a
# colleague inside this window. Thread id + shared log live in
# ~/.agent-sessions/<claude-session-id>/ .
set -euo pipefail

SANDBOX=read-only          # Codex proposes, Claude applies. --write lets Codex edit files.
RESET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write) SANDBOX=workspace-write; shift ;;
    --reset) RESET=1; shift ;;
    *) break ;;
  esac
done
MSG="${1:-$(cat)}"
[ -n "$MSG" ] || { echo "usage: codex-pair.sh [--write|--reset] <message>" >&2; exit 2; }

SID="${CLAUDE_CODE_SESSION_ID:-nosession}"
DIR="$HOME/.agent-sessions/$SID"; mkdir -p "$DIR"
THREAD_FILE="$DIR/codex-thread"; LOG="$DIR/transcript.md"
[ -n "$RESET" ] && rm -f "$THREAD_FILE"

OUT="$(mktemp)"
if [ -s "$THREAD_FILE" ]; then
  THREAD="$(cat "$THREAD_FILE")"
  codex exec resume "$THREAD" --skip-git-repo-check --json "$MSG" </dev/null >"$OUT" 2>/dev/null || true
  # resume can fail if the thread was archived/deleted -> fall through to a fresh thread
  grep -q '"agent_message"' "$OUT" || rm -f "$THREAD_FILE"
fi
if [ ! -s "$THREAD_FILE" ]; then
  PREAMBLE="너는 Claude Code 세션 안에서 함께 일하는 동료 개발자다. Claude가 메시지를 중계한다. 작업 디렉터리: $PWD. 답은 간결하고 구체적으로. 파일을 고쳐야 하면 diff나 정확한 수정 지시로 제안한다 (읽기 전용 샌드박스). 이 스레드는 세션 내내 이어지므로 앞선 대화를 기억하라."
  codex exec -C "$PWD" -s "$SANDBOX" --skip-git-repo-check --json "$PREAMBLE"$'\n\n'"$MSG" </dev/null >"$OUT" 2>/dev/null || true
  THREAD="$(python3 -c 'import json,sys
for l in open(sys.argv[1]):
    try: o=json.loads(l)
    except ValueError: continue
    if o.get("type")=="thread.started": print(o["thread_id"]); break' "$OUT")"
  [ -n "$THREAD" ] && printf '%s\n' "$THREAD" > "$THREAD_FILE"
fi

REPLY="$(python3 -c 'import json,sys
msgs=[]; err=""
for l in open(sys.argv[1]):
    try: o=json.loads(l)
    except ValueError: continue
    if o.get("type")=="item.completed" and o["item"].get("type")=="agent_message": msgs.append(o["item"]["text"])
    if o.get("type")=="error": err=o.get("message","")
print("\n\n".join(msgs) if msgs else "(Codex 응답 없음"+(": "+err if err else "")+")")' "$OUT")"
rm -f "$OUT"

{
  echo; echo "## $(date '+%H:%M:%S') CLAUDE → CODEX"; echo "$MSG"
  echo; echo "## $(date '+%H:%M:%S') CODEX → CLAUDE"; echo "$REPLY"
} >> "$LOG"

echo "CODEX_THREAD: ${THREAD:-unknown}"
echo "=== CODEX SAYS ==="
echo "$REPLY"
echo "=== END ==="
