# Chat TUI verification

Scope: the user's TUI request, applied to existing agentsession chat. No external API calls or new dependencies. Session management continues through the existing commands.

- RED: `bun agentsession.test.ts` failed waiting for the fullscreen entry sequence, against the original CLI. Checkpoint: `123c776`.
- GREEN: the same command passes with `tui.ts` and the chat integration.
- The SDK double now reads the latest user message rather than matching control words in historical context.

| Guarantee | Evidence |
| --- | --- |
| Actual terminal enters fullscreen, restores history, scrolls with PgUp/PgDn | Python PTY, called by `bun agentsession.test.ts` |
| Agent selection, Unicode messages, SDK error display, invalid recipient rejected before persistence | Same PTY test plus transcript assertions |
| Draft survives Enter during a running turn; `/quit` cancels the SDK | Same PTY test plus cancellation marker |
| Narrow/short terminal resize stays usable | PTY resize to 40×12 and 10×3, then restore |
| Ctrl+C, Ctrl+D, SIGTERM, external stop restore terminal and end session | Separate PTY scenarios, checking canonical/echo flags |
| `--plain` and `TERM=dumb` avoid fullscreen and terminate | Two PTY fallback scenarios |
| Grapheme wrapping respects Korean/emoji widths; terminal escape sequences are stripped | Executable assertions in `agentsession.test.ts` |
| Existing stop/history/EOF/signals/both-SDK cancellation behavior remains | Existing CLI lifecycle assertions |
| Mention forwarding parser remains valid | `bun agentsession.ts selftest`: `selftest ok` |

Build: `bun build agentsession.ts --target=bun --packages=external --outfile=/tmp/agentsession-tui-check.js` passed. `git diff --check` passed.

Coverage: `bun test --coverage agentsession.test.ts` completes all assertion-based checks; it reports zero registered Bun tests because this repo uses an executable assert script. Parent-process `tui.ts` line coverage is 79.49%, functions 33.33%; subprocess PTY execution is not included. This is not an aggregate coverage result or proof of the 80% threshold.

Quality limits: no project typecheck/lint configuration, Bun type declarations, or Plankton executable is installed. Build, executable checks, and manual diff/security review were completed; static typecheck/lint were not claimed. Live model calls and Windows terminals were not exercised. Plain mode deliberately uses canonical terminal input; rich editing is in the TUI. Long transcripts are rewrapped when a message arrives or the window resizes.

Self-evaluation: accuracy 4/5 (SDKs mocked); completeness 4/5 (aggregate coverage unmeasured); clarity 4/5 (roster truncates in narrow terminals); actionability 5/5 (existing launch command works); conciseness 4/5 (separate PTY script is needed for terminal behavior). Overall 4.2/5. Future improvements: measure subprocess coverage and manually check the user's terminal/IME. Scope and verification limitations are explicit.
