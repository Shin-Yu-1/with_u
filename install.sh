#!/usr/bin/env bash
# install.sh — set up the Claude+Codex shared-session toolkit on this machine, end to end.
# Installs whatever is missing: Node (via nvm), bun, claude CLI, codex CLI, Claude plugins
# (ECC, Ponytail), gstack, ECC-for-Codex, Memory Vault + MCP, skills, hooks. Idempotent.
#   ./install.sh            full install
#   ./install.sh --check    report what is present / missing, change nothing
#   ./install.sh --minimal  skip Claude plugins + gstack (agentsession core only)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK=""; MINIMAL=""
for a in "$@"; do case "$a" in --check) CHECK=1;; --minimal) MINIMAL=1;; esac; done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
todo() { printf '  \033[33m→\033[0m %s\n' "$1"; }
has()  { command -v "$1" >/dev/null 2>&1; }
run()  { [ -n "$CHECK" ] && return 0; "$@"; }

# nvm/bun installed earlier in this run must be visible to later steps
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

echo "[1/8] runtimes"
if has node && has npm; then ok "node $(node --version)"; else
  todo "node/npm — installing via nvm"
  run bash -c 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash' >/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && run nvm install --lts >/dev/null && ok "node $(node --version)"
fi
if has bun; then ok "bun $(bun --version)"; else
  todo "bun — installing"; run bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null; has bun && ok "bun $(bun --version)"
fi

echo "[2/8] agent CLIs"
has claude && ok "claude $(claude --version 2>/dev/null | head -1)" || { todo "claude — npm i -g"; run npm i -g @anthropic-ai/claude-code >/dev/null; }
has codex  && ok "codex $(codex --version 2>/dev/null)"           || { todo "codex — npm i -g";  run npm i -g @openai/codex >/dev/null; }

echo "[3/8] logins (interactive if needed)"
if claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then ok "claude logged in"; else
  todo "claude login"; [ -z "$CHECK" ] && claude login; fi
if codex login status 2>&1 | grep -qi 'logged in'; then ok "codex logged in"; else
  todo "codex login"; [ -z "$CHECK" ] && codex login; fi

echo "[4/8] agentsession"
[ -d "$HERE/node_modules/@openai/codex-sdk" ] && ok "SDK deps" || { todo "bun install"; run bash -c "cd '$HERE' && bun install --silent"; }
mkdir -p "$HOME/.local/bin"; run ln -sf "$HERE/agentsession" "$HOME/.local/bin/agentsession"; ok "~/.local/bin/agentsession"
RC="$HOME/.zshrc"; [ "$(basename "${SHELL:-zsh}")" = bash ] && RC="$HOME/.bashrc"
if grep -qs 'export PATH="\$HOME/.local/bin:\$PATH"' "$RC" 2>/dev/null; then ok "PATH in $(basename "$RC")"; else
  todo "PATH → $(basename "$RC")"; run bash -c "printf '\n# agentsession\nexport PATH=\"\$HOME/.local/bin:\$PATH\"\n' >> '$RC'"; fi

echo "[5/8] Claude skills (/pair-codex, /handoff-codex)"
mkdir -p "$HOME/.claude/skills"
for s in pair-codex handoff-codex; do
  if diff -rq "$HERE/skills/$s" "$HOME/.claude/skills/$s" >/dev/null 2>&1; then ok "$s"; else
    todo "$s"; run rm -rf "$HOME/.claude/skills/$s"; run cp -R "$HERE/skills/$s" "$HOME/.claude/skills/$s"; fi
done

echo "[6/8] Claude plugins + gstack"
if [ -n "$MINIMAL" ]; then ok "skipped (--minimal)"; else
  plugins="$(claude plugin list 2>/dev/null || true)"
  for spec in "ecc@ecc:affaan-m/ECC" "ponytail@ponytail:DietrichGebert/ponytail"; do
    plug="${spec%%:*}"; repo="${spec#*:}"
    if echo "$plugins" | grep -q "$plug"; then ok "plugin $plug"; else
      todo "plugin $plug"; run claude plugin marketplace add "$repo" >/dev/null 2>&1 || true
      run claude plugin install "$plug" --scope user >/dev/null 2>&1 || echo "     (failed: claude plugin install $plug — run by hand)"; fi
  done
  if [ -x "$HOME/.claude/skills/gstack/setup" ]; then ok "gstack"; else
    todo "gstack — clone + setup (builds browser binary, takes a while)"
    run git clone -q https://github.com/garrytan/gstack.git "$HOME/.claude/skills/gstack"
    run bash -c "cd '$HOME/.claude/skills/gstack' && ./setup -q && ./setup --host codex -q" || echo "     (gstack setup failed — cd ~/.claude/skills/gstack && ./setup)"
  fi
fi

echo "[7/8] shared memory (ECC Memory Vault) + ECC for Codex"
has ecc && ok "ecc-universal" || { todo "ecc-universal"; run npm i -g ecc-universal >/dev/null; }
[ -d "$HOME/.ecc/memory" ] && ok "user vault" || { todo "ecc memory init --scope user"; run ecc memory init --scope user >/dev/null; }
codex mcp list 2>/dev/null | grep -q ecc-memory-vault && ok "codex MCP ecc-memory-vault" || { todo "codex mcp add"; run codex mcp add ecc-memory-vault --env ECC_MEMORY_HARNESS=codex -- ecc-memory-mcp >/dev/null; }
[ -d "$HOME/.codex/skills/verification-loop" ] && ok "ECC skills for Codex" || { todo "ecc install --target codex"; run ecc install --target codex --profile developer --no-hooks >/dev/null 2>&1 || true; run ecc install --target codex --skills security-review,api-design >/dev/null 2>&1 || true; }
mkdir -p "$HOME/.codex"
if [ -f "$HOME/.codex/AGENTS.md" ]; then
  grep -q 'ECC Memory Vault' "$HOME/.codex/AGENTS.md" && ok "~/.codex/AGENTS.md" || { todo "append rules → ~/.codex/AGENTS.md"; run bash -c "printf '\n' >> '$HOME/.codex/AGENTS.md'; cat '$HERE/codex/AGENTS.md' >> '$HOME/.codex/AGENTS.md'"; }
else todo "~/.codex/AGENTS.md"; run cp "$HERE/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"; fi

echo "[8/8] Claude-side wiring (MCP, CLAUDE.md, hooks)"
if [ -n "${CLAUDECODE:-}" ] && [ -z "$CHECK" ]; then
  echo "  running inside Claude Code — it cannot edit its own settings. Run in a plain terminal:"
  echo "     $HERE/install.sh"
else
  claude mcp list 2>/dev/null | grep -q ecc-memory-vault && ok "claude MCP ecc-memory-vault" || { todo "claude mcp add"; run claude mcp add --scope user ecc-memory-vault -e ECC_MEMORY_HARNESS=claude -- ecc-memory-mcp >/dev/null; }
  grep -qs '공용 세션 상태 (ECC Memory Vault)' "$HOME/.claude/CLAUDE.md" && ok "CLAUDE.md rules" || { todo "append → ~/.claude/CLAUDE.md"; run bash -c "printf '\n' >> '$HOME/.claude/CLAUDE.md'; cat '$HERE/CLAUDE.md.snippet' >> '$HOME/.claude/CLAUDE.md'"; }
  SETTINGS="$HOME/.claude/settings.json"; [ -f "$SETTINGS" ] || run bash -c "echo '{}' > '$SETTINGS'"
  if node -e "const s=require('$SETTINGS');const h=JSON.stringify(s.hooks||{});process.exit(h.includes('agentsession hook')&&h.includes('handoff-codex.sh --hook')?0:1)" 2>/dev/null; then ok "hooks (SessionStart team id, PreCompact handoff)"; else
    todo "merge hooks → settings.json"
    run node -e '
      const fs=require("fs");const [s,...adds]=process.argv.slice(1);const cfg=JSON.parse(fs.readFileSync(s,"utf8"));cfg.hooks=cfg.hooks||{};
      for(const f of adds){const h=JSON.parse(fs.readFileSync(f,"utf8")).hooks;for(const [ev,arr] of Object.entries(h)){cfg.hooks[ev]=cfg.hooks[ev]||[];
        for(const e of arr){if(!JSON.stringify(cfg.hooks[ev]).includes(e.hooks[0].command))cfg.hooks[ev].push(e);}}}
      fs.writeFileSync(s,JSON.stringify(cfg,null,2)+"\n");' "$SETTINGS" "$HERE/skills/claude-sessionstart-hook.json" "$HERE/skills/handoff-codex/precompact-hook.json"
  fi
fi

echo
[ -n "$CHECK" ] && echo "check only — nothing changed." || echo "done. open a new terminal, then:  cd <project> && agentsession"
