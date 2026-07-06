#!/data/data/com.termux/files/usr/bin/bash
# PRPG one-shot installer for Termux (Android). See docs/01-tech-stack.md.
# Usage:  bash scripts/termux-install.sh
set -euo pipefail

echo "== PRPG Termux install =="

# 1. Toolchain. node:sqlite (built into Node >= 22) needs NO native build, so we
#    do not require python/clang/make — a big win on a phone.
if ! command -v node >/dev/null 2>&1; then
  echo "-> installing nodejs-lts + git"
  pkg update -y
  pkg install -y nodejs-lts git
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "-> node $(node -v) detected"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "!! PRPG uses the built-in node:sqlite module and requires Node >= 22."
  echo "   Run: pkg install nodejs-lts   (or upgrade Node) and re-run this script."
  exit 1
fi

# 2. Dependencies (runtime only — the client is pre-built static files).
echo "-> installing npm dependencies (this may take a minute)"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# 3. Config.
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "-> created config.json — EDIT IT and add your API key(s) before starting."
fi

# 4. Migrate DB.
npm run migrate || true

cat <<'EOF'

== Done ==
Next:
  1. Edit config.json and add your provider API key(s).
  2. (Recommended) run: termux-wake-lock     # keep the server alive when screen is off
  3. Start the server:  npm start
  4. Open http://127.0.0.1:7777 in your phone's browser.

Verify your setup any time with:  npm run smoke
EOF
