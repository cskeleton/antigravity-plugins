#!/bin/sh
# One-step installer for antigravity-conversation-export (Antigravity.app + agy TUI CLI)
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARENT_DIR="$(dirname "$REPO_DIR")"
PLUGIN_DIR_NAME="$(basename "$REPO_DIR")"

chmod +x "$REPO_DIR/scripts/run-node.sh" \
         "$REPO_DIR/scripts/agy-export.mjs" \
         "$REPO_DIR/assets/compress_png.py" \
         "$REPO_DIR/assets/quantize_png.py"

# 1. Register plugin in ~/.gemini/config/plugins.json (preserving existing entries)
mkdir -p "$HOME/.gemini/config"
PLUGINS_JSON="$HOME/.gemini/config/plugins.json"
"$REPO_DIR/scripts/run-node.sh" -e '
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = process.argv[1];
const parentDir = process.argv[2];
const dirName = process.argv[3];
let cfg = { entries: [] };
if (existsSync(file)) {
  try { cfg = JSON.parse(readFileSync(file, "utf-8")); } catch {}
}
if (!Array.isArray(cfg.entries)) cfg.entries = [];

let matchedEntry = cfg.entries.find(e => e.path === parentDir && Array.isArray(e.include_only));
if (matchedEntry) {
  if (!matchedEntry.include_only.includes(dirName)) {
    matchedEntry.include_only.push(dirName);
  }
} else {
  const alreadyCovered = cfg.entries.some(e => e.path === parentDir && !e.include_only);
  if (!alreadyCovered) {
    cfg.entries.push({ path: parentDir, include_only: [dirName] });
  }
}
writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "$PLUGINS_JSON" "$PARENT_DIR" "$PLUGIN_DIR_NAME"

# 2. Install `agy-export` CLI wrapper into ~/.local/bin/agy-export
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/agy-export" <<EOF
#!/bin/sh
exec "$REPO_DIR/scripts/run-node.sh" "$REPO_DIR/scripts/agy-export.mjs" "\$@"
EOF
chmod +x "$HOME/.local/bin/agy-export"

echo "✅ antigravity-conversation-export installed successfully!"
echo "   - Plugin registered in: $PLUGINS_JSON"
echo "   - CLI command installed: $HOME/.local/bin/agy-export"
