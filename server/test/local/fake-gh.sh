#!/bin/bash
# Fake GitHub CLI for tests: logs its arguments, answers the calls LocalDex makes.
echo "$*" >> "${FAKE_GH_LOG:-/dev/null}"
case "$1 $2" in
  "--version "*) echo "gh version 2.99.0 (fake)"; exit 0 ;;
  "auth status") exit 0 ;;
  "pr create") echo "Creating pull request..."; echo "https://github.com/p/r/pull/42"; exit 0 ;;
  "pr view") echo '{"state":"MERGED","reviewDecision":"APPROVED","statusCheckRollup":[{"conclusion":"SUCCESS"}],"mergedAt":"2026-11-04T00:00:00Z"}'; exit 0 ;;
esac
exit 1
