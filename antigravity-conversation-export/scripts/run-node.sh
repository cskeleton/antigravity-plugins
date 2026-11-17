#!/bin/sh
# Node.js locator wrapper for Antigravity Conversation Export.
# Ensures Node >= 22.5 (with built-in node:sqlite) is used even in GUI environments with minimal PATH.

if [ -n "$ANTIGRAVITY_NODE_PATH" ] && [ -x "$ANTIGRAVITY_NODE_PATH" ]; then
  exec "$ANTIGRAVITY_NODE_PATH" "$@"
fi

for candidate in \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "$(command -v node 2>/dev/null)"
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    exec "$candidate" "$@"
  fi
done

HELPER="/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper"
if [ -x "$HELPER" ]; then
  export ELECTRON_RUN_AS_NODE=1
  exec "$HELPER" "$@"
fi

echo "Error: Could not find a suitable Node.js runtime." >&2
exit 1
