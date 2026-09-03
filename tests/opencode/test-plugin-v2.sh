#!/usr/bin/env bash
# Test: OpenCode 2 plugin (superpowers-v2.js)
# Verifies skill-source registration, bootstrap injection, dedup, and caching
# against a mock v2 context. Requires no OpenCode install.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_FILE="$REPO_ROOT/.opencode/plugins/superpowers-v2.js"

echo "=== Test: OpenCode 2 plugin (superpowers-v2.js) ==="

echo "Test 1: Plugin JavaScript syntax..."
if node --check "$PLUGIN_FILE" 2>/dev/null; then
    echo "  [PASS] Syntax valid"
else
    echo "  [FAIL] Syntax errors"
    exit 1
fi

echo "Test 2: setup(ctx) behavior (skill source, bootstrap injection, dedup, caching)..."
node "$SCRIPT_DIR/test-plugin-v2.mjs" "$PLUGIN_FILE"

echo ""
echo "=== All OpenCode 2 plugin tests passed ==="
