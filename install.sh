#!/usr/bin/env bash
# install.sh — set up the Claude+Codex shared-session toolkit on this machine.
# Requires: node (npm), bun, claude CLI (logged in), codex CLI (logged in). macOS/Linux.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2"; exit 1; }; }
need bun    "curl -fsSL https://bun.sh/install | bash"
need npm    "install Node.js (nvm recommended)"
need claude "npm i -g @anthropic-ai/claude-code && claude login"
need codex  "npm i -g @openai/codex && codex login"

echo "[1/5] SDK deps"; (cd "$HERE" && bun install --silent)

echo "[2/5] agentsession on PATH"
mkdir -p "$HOME/.local/bin"; ln -sf "$HERE/agentsession" "$HOME/.local/bin/agentsession"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo '   add to your shell rc:  export PATH="$HOME/.local/bin:$PATH"';; esac

echo "[3/5] Claude skills (/pair-codex, /handoff-codex)"
mkdir -p "$HOME/.claude/skills"
for s in pair-codex handoff-codex; do
  rm -rf "$HOME/.claude/skills/$s"; cp -R "$HERE/skills/$s" "$HOME/.claude/skills/$s"
done

echo "[4/5] Memory Vault (shared cross-agent store) + Codex MCP"
npm ls -g ecc-universal >/dev/null 2>&1 || npm i -g ecc-universal
ecc memory init --scope user >/dev/null 2>&1 || true
codex mcp list 2>/dev/null | grep -q ecc-memory-vault || codex mcp add ecc-memory-vault --env ECC_MEMORY_HARNESS=codex -- ecc-memory-mcp
echo "   ECC skills for Codex agents (developer profile, no hooks)"
ecc install --target codex --profile developer --no-hooks >/dev/null 2>&1 || echo "   ecc install --target codex failed; run it by hand"
ecc install --target codex --skills security-review,api-design >/dev/null 2>&1 || true
mkdir -p "$HOME/.codex"
[ -f "$HOME/.codex/AGENTS.md" ] && echo "   ~/.codex/AGENTS.md exists — merge $HERE/codex/AGENTS.md by hand" || cp "$HERE/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"

echo "[5/5] Claude-side wiring (needs your approval; run yourself)"
cat <<EOF
   claude mcp add --scope user ecc-memory-vault -e ECC_MEMORY_HARNESS=claude -- ecc-memory-mcp
   cat $HERE/CLAUDE.md.snippet >> ~/.claude/CLAUDE.md
   # optional: show this folder's team session id whenever you start `claude`
   jq -s '.[0] * .[1]' ~/.claude/settings.json $HERE/skills/claude-sessionstart-hook.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
   # optional: auto-handoff to Codex when context runs out
   jq -s '.[0] * .[1]' ~/.claude/settings.json $HERE/skills/handoff-codex/precompact-hook.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json
EOF
echo "done. try:  cd <project> && agentsession new && agentsession chat <sid>"
