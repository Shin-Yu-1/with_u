---
name: pair-codex
description: Work with OpenAI Codex as a second developer inside this Claude Code window. One persistent Codex thread per Claude session, so Codex remembers the whole conversation. Use when asked to "codex랑 같이", "코덱스한테 물어봐", "pair with codex", "codex 의견", or when a second opinion / parallel analysis would help.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# /pair-codex — 한 창에서 Claude + Codex 협업

Codex는 이 세션에 붙은 동료다. 스레드가 세션 내내 유지되므로 매번 배경을 다시 설명하지 않는다.
Claude가 중계자이자 유일한 파일 편집자다. Codex는 읽기 전용 샌드박스에서 분석·제안한다.

## 사용

```bash
~/.claude/skills/pair-codex/codex-pair.sh "<Codex에게 보낼 메시지>"
~/.claude/skills/pair-codex/codex-pair.sh --write "<메시지>"   # Codex가 직접 파일 수정 (새 스레드일 때만 적용)
~/.claude/skills/pair-codex/codex-pair.sh --reset "<메시지>"   # 스레드 새로 시작
```

Bash `timeout` 파라미터는 300000 이상으로 준다.

## 절차

1. **메시지 구성.** 사용자의 요청을 그대로 옮기지 말고, Codex가 바로 답할 수 있게 만든다:
   질문 + 관련 파일 경로 + 필요한 코드 조각/diff(짧게). 첫 호출이 아니면 앞 대화를 반복하지 않는다.
2. **실행.** 스크립트 출력의 `=== CODEX SAYS ===` 블록을 **그대로** 사용자에게 보여준다. 요약·편집 금지.
3. **종합.** 블록 아래에 Claude의 판단을 2~3줄로: 동의/반대 지점, 다음 행동.
   Codex 제안을 적용할 때는 Claude가 Edit로 반영하고, 결과를 다음 `/pair-codex` 호출로 Codex에 알린다.
4. 사용자가 "codex한테 ~라고 해" 식으로 말하면 그대로 중계하고 답을 보여준다.

## 기록

`~/.agent-sessions/<claude-session-id>/transcript.md`에 양방향 메시지가 쌓인다.
`/handoff-codex`나 Memory Vault handoff를 쓸 때 이 파일 경로를 포함하면 Codex 쪽 맥락도 함께 넘어간다.
