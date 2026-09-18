# agentsession — Claude + Codex 공유 세션 툴킷

여러 AI 에이전트(Claude Code, OpenAI Codex)가 **하나의 세션 ID**로 협업한다.

| 도구 | 용도 |
|---|---|
| `agentsession` | 공유 sid 아래서 에이전트들이 서로 대화·작업. Claude Agent SDK + Codex SDK |
| `/pair-codex` (Claude 스킬) | Claude 창 안에서 Codex 한 명과 협업 (스레드 유지) |
| `/handoff-codex` (Claude 스킬) | 컨텍스트 소진 시 Codex로 작업 인계 |
| ECC Memory Vault | 세션을 넘어 남는 결정·사실·handoff 공용 저장소 |

## 설치 (다른 머신)

```bash
git clone https://github.com/Shin-Yu-1/with_u.git ~/.agentsession && ~/.agentsession/install.sh
```
없는 것은 전부 설치한다: Node(nvm), bun, claude/codex CLI, 로그인(필요 시 브라우저 열림), Claude 플러그인(ECC, Ponytail), gstack, ECC-for-Codex, Memory Vault + MCP(양쪽), 스킬, 훅. 다시 실행해도 안전(idempotent).

- `./install.sh --check`   무엇이 있고 없는지만 보고, 아무것도 바꾸지 않음
- `./install.sh --minimal` Claude 플러그인·gstack 건너뜀 (agentsession 핵심만)
- 일반 터미널에서 실행한다. Claude Code 세션 안에서 실행하면 8단계(Claude 설정 편집)는 건너뛰고 안내만 출력한다.

## 사용

## 팀 구성 (`roles.json`)

`agentsession new`는 기본 팀을 만든다. 역할·모델은 `roles.json`에서 바꾼다.

| 이름 | 모델 | 역할 |
|---|---|---|
| `pm` (기본) | Claude Fable | 총관리·기획. 일을 쪼개 배정, 결과 통합 보고. 코드 안 만짐 |
| `planner` | GPT-6 Astra | 기획 작성·기획/구현 검토 (반박 위주) |
| `dev-terra` | GPT-5.6 Terra | 복잡한 기능 구현·리팩터링. Ponytail |
| `dev-luna` | GPT-5.6 Luna | 중간 난이도 구현. Ponytail |
| `dev-lite` | Claude Sonnet | 단순 수정만. 설계 판단 필요하면 pm에게 반려. Ponytail |

Ponytail 규칙은 `roles.json`의 `_ponytail`, ECC 사용 규칙은 `_ecc_claude`(Claude: /ecc:feature-dev, /ecc:build-fix, ecc:code-reviewer)와 `_ecc_codex`(Codex: ~/.codex/skills의 tdd-workflow, verification-loop, security-review 등)에 있고 역할 프롬프트의 `$PONYTAIL`/`$ECC_*` 자리에 들어간다. Claude 에이전트는 사용자 플러그인(ECC, Ponytail, gstack)을 그대로 로드한다.
임시 팀: `agentsession new --agents pm:claude:opus,dev:codex:gpt-5.6-terra`

가장 짧은 사용법: 프로젝트 폴더에서 **`agentsession`** (인자 없음). 이 폴더의 최근 공유 세션을 이어가고, 없으면 기본 팀을 만들고, 세션 ID를 알려준 뒤 바로 chat에 들어간다.
`agentsession current`는 이 폴더의 세션 ID만 출력한다 (스크립트·훅용).

터미널에서는 `agentsession` 또는 `agentsession chat <sid>`가 전체 화면 TUI를 연다.
상단에 세션·참여자(`*`는 기본 에이전트), 중앙에 대화, 하단에 작업 상태와 입력창을 표시한다.
`@이름 메시지` 또는 `@all 메시지`로 전송하고, PgUp/PgDn으로 이전 대화를 본다. 방향키·Ctrl+U 등 readline 입력 편집도 사용할 수 있다.
작업 중에도 초안을 작성할 수 있으며, 완료 후 Enter로 보낸다. `/quit`, `/q`, Ctrl+C는 진행 중인 작업까지 취소하고 터미널을 복원한다.
기존 줄 단위 화면은 `agentsession --plain` 또는 `agentsession chat <sid> --plain`으로 실행한다. 파이프와 `TERM=dumb`에서는 자동으로 일반 화면을 사용한다.

```bash
cd <project>
SID=$(agentsession new)                 # 기본 팀. --team <이름> 으로 다른 팀
agentsession chat $SID                  # @codex ... / @claude ... / @all ... / 그냥 입력 → 기본 에이전트
agentsession run  $SID codex "..."      # 스크립트용 단일 턴
agentsession show $SID
agentsession list                       # 종료하지 않은 공유 세션 목록
agentsession stop $SID                  # ID로 세션 종료 (진행 중인 에이전트 작업도 취소)
```
에이전트가 답변 줄 앞에 `@이름: ...`을 쓰면 그 상대에게 자동 전달된다 (최대 4홉).

채팅에서 `/quit`·`/q`, Ctrl+C, 입력 종료 또는 터미널 종료 시 세션을 종료한다.
종료된 세션은 `list`, `current`, 자동 이어가기에서 제외하고, 같은 ID로 `chat`·`run`을 다시 실행할 수 없다.
기록은 보존하므로 `agentsession show <sid>`로 조회할 수 있다. `run` 한 번의 정상 완료는 공유 세션을 종료하지 않는다.
`stop`은 실행 중인 프로세스가 최대 약 200ms 뒤 감지하여 SDK 취소를 요청한다.
업데이트 전에 켜 둔 프로세스에는 취소 감지가 없으므로 한 번 직접 종료해야 한다. 이전 종료 기록이나 강제 종료(`kill -9`)는 `stop <sid>`로 목록에서 정리한다.

## 데이터

`~/.agent-sessions/<sid>/session.json` (참여자, 네이티브 세션 ID), `transcript.jsonl` (공유 기록), `stopped` (종료 표시).

검증: `bun agentsession.test.ts` (임시 저장소와 SDK 대역을 사용한 CLI/TUI 회귀 검사, PTY 검사는 Python 3 필요), `bun agentsession.ts selftest` (멘션 파싱).
