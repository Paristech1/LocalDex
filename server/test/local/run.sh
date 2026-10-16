#!/bin/bash
# Local-model recovery tests: the real agent loop against a mock LM Studio that replays real small-model failures.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export DEMO_DIR="$TMP/demo" LOCALDEX_HOME="$TMP/home" MOCK_PORT="${MOCK_PORT:-17431}"
mkdir -p "$DEMO_DIR" "$LOCALDEX_HOME"
cat > "$LOCALDEX_HOME/config.json" <<JSON
{ "baseUrl": "http://127.0.0.1:$MOCK_PORT/v1", "model": "gemma-mock", "toolMode": "auto", "reasoning": "auto",
  "approvedFolders": ["$DEMO_DIR"], "shellApproval": "dangerous", "maxSteps": 20 }
JSON
cd "$HERE/../.."
npx tsx "$HERE/local.test.mts"
