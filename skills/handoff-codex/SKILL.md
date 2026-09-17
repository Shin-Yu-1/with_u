---
name: handoff-codex
description: Hand the current Claude Code session off to OpenAI Codex CLI — bundles a task summary plus the full session transcript into one file and opens Codex on it. Use when context/usage is about to run out, or when asked to "코덱스로 넘겨", "handoff to codex", "codex에게 이어서", "continue in codex".
allowed-tools:
  - Bash
  - Write
  - Read
---

# /handoff-codex — Claude 세션을 Codex로 넘기기

컨텍스트나 사용량 한도가 임박했을 때 현재 작업을 Codex CLI로 이어받게 한다.
산출물은 하나: `~/.codex-handoff/<시각>-<세션>.md` (요약 + git 상태 + 대화 기록).
Codex는 그 파일을 첫 프롬프트로 읽고 이어서 작업한다.

## Step 1: 요약 작성 (Claude가 직접)

`/tmp` 대신 스크래치패드 디렉터리에 `handoff-summary.md`를 Write 도구로 작성한다.
대화 기록은 스크립트가 자동으로 붙이므로 여기엔 **판단이 필요한 정보만** 짧게 쓴다:

```markdown
### 목표
(사용자가 원한 것, 1~2문장)

### 완료
- (끝난 것, 검증 여부 포함)

### 남은 작업
1. (다음 할 일부터, 구체적으로 — 파일/함수/명령 이름 포함)

### 결정 사항 / 주의
- (사용자가 정한 것, 하지 말라고 한 것, 함정)

### 핵심 파일
- path — 왜 중요한지 한 줄

### 검증 방법
(테스트/빌드 명령)
```

## Step 2: 핸드오프 실행

```bash
~/.claude/skills/handoff-codex/handoff-codex.sh <summary.md 경로>
```

- 기본: 새 iTerm(없으면 Terminal) 창에서 대화형 `codex`가 열리고 핸드오프 파일을 읽는다.
- `--exec`: 창을 열지 않고 `codex exec`로 비대화형 실행 (원격/헤드리스용).
- `--no-launch`: 파일만 만들고 끝. 사용자가 직접 `codex` 후 파일 경로를 붙여넣는다.

사용자가 모드를 말하지 않으면 기본(대화형 창)을 쓴다.

저장소에 `ecc` CLI와 git이 있으면 스크립트가 요약을 ECC Memory Vault(`.ecc/memory/project/handoffs/`)에도
`handoff`(from claude → target codex)로 기록한다. Codex는 세션 시작 시 `memory_search`로 이를 읽는다.
출력에 `(vault에도 기록됨)`이 붙으면 성공.

## Step 3: 마무리

출력의 `HANDOFF_FILE:` 경로와 `LAUNCHED:` 결과, vault 기록 여부를 사용자에게 알린다.
이후 이 Claude 세션에서는 같은 파일을 건드리지 않는다 (Codex와 충돌).
Codex 쪽 세션은 나중에 `codex resume --last`로 다시 열 수 있다.
