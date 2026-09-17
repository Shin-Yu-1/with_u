#!/usr/bin/env bash
# handoff-codex.sh [--no-launch|--exec] <summary.md>
# Bundles Claude's summary + the current Claude session transcript into one
# handoff file, then opens Codex on it (new iTerm/Terminal window by default).
set -euo pipefail

MODE=launch
HOOK=""
case "${1:-}" in
  --no-launch) MODE=none; shift ;;
  --exec)      MODE=exec; shift ;;
  --hook)        MODE=none;   HOOK=1; shift ;;   # hook: stdin = hook JSON, save only
  --hook-launch) MODE=launch; HOOK=1; shift ;;   # hook: save + open Codex window + stop Claude
esac

CWD="$PWD"
SID="${CLAUDE_CODE_SESSION_ID:-}"
HOOK_TRANSCRIPT=""
if [ -n "$HOOK" ]; then
  eval "$(python3 -c 'import json,sys,shlex;o=json.load(sys.stdin);print("SID=%s;CWD=%s;HOOK_TRANSCRIPT=%s"%(shlex.quote(o.get("session_id","")),shlex.quote(o.get("cwd","")) or "$PWD",shlex.quote(o.get("transcript_path",""))))')"
  SUMMARY="$(mktemp)"; printf '(자동 저장: 컨텍스트 압축 직전에 훅이 생성. Claude 요약 없음 — 아래 대화 기록과 git 상태로 판단.)\n' > "$SUMMARY"
else
  SUMMARY="${1:?usage: handoff-codex.sh [--no-launch|--exec|--hook] <summary.md>}"
fi
SLUG="$(printf '%s' "$CWD" | sed 's#[/_.]#-#g')"
TRANSCRIPT="${HOOK_TRANSCRIPT:-$HOME/.claude/projects/$SLUG/$SID.jsonl}"
[ -f "$TRANSCRIPT" ] || TRANSCRIPT="$(ls -t "$HOME/.claude/projects/$SLUG"/*.jsonl 2>/dev/null | head -1 || true)"

OUTDIR="$HOME/.codex-handoff"; mkdir -p "$OUTDIR"
OUT="$OUTDIR/$(date +%Y%m%d-%H%M%S)-${SID:0:8}.md"

{
  echo "# Claude → Codex 핸드오프"
  echo
  echo "- 생성: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 작업 디렉터리: $CWD"
  echo "- 브랜치: $(git -C "$CWD" branch --show-current 2>/dev/null || echo '(git 아님)')"
  echo "- Claude 세션: ${SID:-unknown}  (Claude Code로 되돌리려면: cd $CWD && claude -r $SID)"
  echo
  echo "## 지시"
  echo "너는 이 작업을 Claude Code로부터 이어받는다. 아래 요약과 대화 기록을 먼저 읽고,"
  echo "'남은 작업'부터 바로 이어서 진행한다. 이미 끝난 일은 다시 하지 않는다."
  echo
  echo "## Claude 요약"
  cat "$SUMMARY"
  echo
  if git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "## Git 상태"
    echo '```'
    git -C "$CWD" status --short | head -50
    echo '---'
    git -C "$CWD" diff --stat | tail -20
    echo '```'
    echo
  fi
  if [ -f "$TRANSCRIPT" ]; then
    echo "## 세션 대화 기록 (도구 결과·사고 과정 제외, 블록당 최대 2000자)"
    python3 - "$TRANSCRIPT" <<'PY'
import json, sys
CAP = 2000
def clip(s): s = s.strip(); return s if len(s) <= CAP else s[:CAP] + " …[잘림]"
for line in open(sys.argv[1], encoding="utf-8"):
    try: o = json.loads(line)
    except ValueError: continue
    t = o.get("type")
    if t not in ("user", "assistant") or o.get("isMeta") or o.get("isSidechain"): continue
    c = o.get("message", {}).get("content")
    if isinstance(c, str):
        if t == "user" and c.strip(): print(f"\n**USER:** {clip(c)}")
        continue
    for b in c or []:
        bt = b.get("type")
        if bt == "text" and b.get("text", "").strip():
            print(f"\n**{'USER' if t=='user' else 'CLAUDE'}:** {clip(b['text'])}")
        elif bt == "tool_use":
            inp = b.get("input", {})
            brief = inp.get("command") or inp.get("file_path") or inp.get("skill") or json.dumps(inp, ensure_ascii=False)
            print(f"\n- 도구 `{b.get('name')}`: {clip(str(brief))[:300]}")
PY
  else
    echo "## 세션 대화 기록"; echo "(트랜스크립트를 찾지 못함: $TRANSCRIPT)"
  fi
} > "$OUT"

# Shared state: also record the handoff in the ECC Memory Vault (project scope) when available.
VAULT_NOTE=""
if command -v ecc >/dev/null 2>&1 && git -C "$CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  [ -d "$CWD/.ecc/memory/project" ] || (cd "$CWD" && ecc memory init >/dev/null 2>&1) || true
  { cat "$SUMMARY"; echo; echo "전체 세션 기록: $OUT"; } | (cd "$CWD" && ECC_MEMORY_HARNESS=claude ecc memory handoff \
      --from claude --target codex --title "Claude → Codex 핸드오프 $(date '+%m-%d %H:%M')" --tag handoff --stdin 2>/dev/null) \
    && VAULT_NOTE=" (vault에도 기록됨)" || VAULT_NOTE=""
fi

if [ -n "$HOOK" ]; then
  rm -f "$SUMMARY"
  if [ "$MODE" = none ]; then
    python3 -c 'import json,sys;print(json.dumps({"systemMessage":"컨텍스트 압축 직전 핸드오프 파일 저장: %s — Codex로 넘기려면 /handoff-codex, 또는 새 터미널에서: codex \"%s 파일을 읽고 남은 작업부터 이어서 진행\""%(sys.argv[1],sys.argv[1])},ensure_ascii=False))' "$OUT"
    exit 0
  fi
else
  echo "HANDOFF_FILE: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)$VAULT_NOTE"
fi

PROMPT="$OUT 파일을 먼저 읽고, 거기 적힌 '남은 작업'부터 이어서 진행해. 진행 전에 한 줄로 현재 상태를 요약해줘."
case "$MODE" in
  none) ;;
  exec)
    codex exec -C "$CWD" --skip-git-repo-check "$PROMPT" </dev/null ;;
  launch)
    CMD="cd $(printf '%q' "$CWD") && codex $(printf '%q' "$PROMPT")"
    if [ -d /Applications/iTerm.app ]; then
      osascript -e 'tell application "iTerm"' \
                -e 'set w to (create window with default profile)' \
                -e "tell current session of w to write text $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1],ensure_ascii=False))' "$CMD")" \
                -e 'end tell' >/dev/null
      LAUNCHED=iTerm
    else
      osascript -e "tell application \"Terminal\" to do script $(python3 -c 'import json,sys;print(json.dumps(sys.argv[1],ensure_ascii=False))' "$CMD")" >/dev/null
      LAUNCHED=Terminal
    fi
    if [ -n "$HOOK" ]; then
      # Stop this Claude turn so Claude and Codex never edit the same tree at once.
      python3 -c 'import json,sys;print(json.dumps({"continue":False,"stopReason":"컨텍스트 한도 도달 → Codex로 인계 완료 (%s 새 창). 핸드오프 파일: %s"%(sys.argv[1],sys.argv[2])},ensure_ascii=False))' "$LAUNCHED" "$OUT"
    else
      echo "LAUNCHED: $LAUNCHED"
    fi ;;
esac
