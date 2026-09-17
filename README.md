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
git clone <this repo> ~/.agentsession && ~/.agentsession/install.sh
```
마지막 단계에 출력되는 Claude 쪽 명령 3개는 직접 실행한다 (Claude Code가 자기 설정 편집을 승인 없이 못 함).

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

```bash
cd <project>
SID=$(agentsession new)                 # 기본 팀. --team <이름> 으로 다른 팀
agentsession chat $SID                  # @codex ... / @claude ... / @all ... / 그냥 입력 → 기본 에이전트
agentsession run  $SID codex "..."      # 스크립트용 단일 턴
agentsession show $SID
```
에이전트가 답변 줄 앞에 `@이름: ...`을 쓰면 그 상대에게 자동 전달된다 (최대 4홉).

## 데이터

`~/.agent-sessions/<sid>/session.json` (참여자, 네이티브 세션 ID), `transcript.jsonl` (공유 기록).
