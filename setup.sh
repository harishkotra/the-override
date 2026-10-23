#!/usr/bin/env bash
# One-shot setup for The Override. macOS or Linux. Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites -----------------------------------------------------------
say "1/5 checking prerequisites"
command -v node >/dev/null || die "node not found. Install Node 18+ (brew install node)."
command -v npm  >/dev/null || die "npm not found. Install Node 18+ (brew install node)."
command -v python3 >/dev/null || die "python3 not found. Install Python 3.11+ (brew install python@3.12)."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR is too old. Need 18+."

PYVER=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
PY_MAJOR=$(echo "$PYVER" | cut -d. -f1)
PY_MINOR=$(echo "$PYVER" | cut -d. -f2)
{ [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 11 ]; } || die "python3 is $PYVER but agents-cli needs 3.11+.
  Try: brew install python@3.12 && PATH=\"/opt/homebrew/opt/python@3.12/bin:\$PATH\" ./setup.sh"
echo "   node $(node -v), python $PYVER"

# ---- python venv + the real CLI ---------------------------------------------
say "2/5 installing agents-cli ${AGENTS_CLI_VERSION:-1.11.0} into ./.venv (the binary that judges extensions)"
if [ ! -x .venv/bin/agents-cli ]; then
  [ -d .venv ] || python3 -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  ./.venv/bin/pip install -q "google-agents-cli==${AGENTS_CLI_VERSION:-1.11.0}"
fi
./.venv/bin/agents-cli --version

# ---- node deps + build -------------------------------------------------------
say "3/5 installing node deps and building the UI"
if [ -f package-lock.json ]; then npm ci --silent; else npm install --silent; fi
npm run build

# ---- env --------------------------------------------------------------------
say "4/5 configuring the model endpoint"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "   created .env from .env.example"
fi
if ! grep -q '^PARTICLE_API_KEY=..*' .env; then
  echo
  echo "   No API key set yet. Edit .env and fill in:"
  echo "     PARTICLE_API_KEY=your-key-here"
  echo "   Base URL defaults to https://api.particle.ai/v1, any OpenAI-compatible endpoint works."
  echo "   (You can also export PARTICLE_API_KEY in your shell before starting.)"
fi

# ---- sanity ------------------------------------------------------------------
say "5/5 sanity check"
./.venv/bin/agents-cli --help >/dev/null && echo "   agents-cli responds"
[ -f dist/index.html ] && echo "   dist/ built"

cat <<'EOF'

Done. Start it with:

  npm start            # http://127.0.0.1:8791   (single port, built UI + api)

Dev mode with hot reload:

  npm run dev          # UI on :5273, api on :8791

Full headless check (compiles a policy, installs it, runs it, prints the transcripts):

  npm run smoke        # needs PARTICLE_API_KEY in .env

Want to open it from another device on the same wifi:

  HOST=0.0.0.0 PORT=8791 npm start     # then http://<this-machines-ip>:8791
EOF
