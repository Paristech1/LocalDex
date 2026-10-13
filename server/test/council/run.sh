#!/bin/bash
# Sets up a throwaway project + LocalDex home pointing at the stand-in CLIs, then runs the council test.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export DEMO_DIR="$TMP/demo" LOCALDEX_HOME="$TMP/home" FAKE_CTL="$TMP/ctl" GEMINI_CLI_HOME="$TMP/gem" LOCALDEX_CURSOR_SDK="$HERE/fake-cursor-sdk.mjs"
mkdir -p "$DEMO_DIR/src" "$LOCALDEX_HOME" "$FAKE_CTL" "$GEMINI_CLI_HOME/.gemini"
printf 'export function add(a: number, b: number) {\n  return a + b;\n}\n' > "$DEMO_DIR/src/math.ts"
printf '# Demo\n' > "$DEMO_DIR/README.md"
git -C "$DEMO_DIR" init -q && git -C "$DEMO_DIR" add -A && git -C "$DEMO_DIR" -c user.name=t -c user.email=t@t commit -qm init
echo '{"security":{"auth":{"selectedType":"oauth-personal"}}}' > "$GEMINI_CLI_HOME/.gemini/settings.json"
echo '{}' > "$GEMINI_CLI_HOME/.gemini/oauth_creds.json"
echo '{"active":"paris@example.com"}' > "$GEMINI_CLI_HOME/.gemini/google_accounts.json"
cat > "$LOCALDEX_HOME/config.json" <<JSON
{ "approvedFolders": ["$DEMO_DIR"],
  "council": { "enabled": true, "allowWrite": true, "confirmWrites": true,
    "members": { "claude": {"enabled": true, "command": "$HERE/fakebin/claude", "model": "sonnet", "heavyModel": "opus"},
                 "codex": {"enabled": true, "command": "$HERE/fakebin/codex"},
                 "gemini": {"enabled": true, "command": "$HERE/fakebin/gemini"},
                 "cursor": {"enabled": true, "model": "auto"} } } }
JSON
cd "$HERE/../.."
npx tsx "$HERE/council.test.mts"
