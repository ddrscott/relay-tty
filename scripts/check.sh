#!/usr/bin/env bash
# The gate CI runs on every push and PR. Green here means green in CI.
# Usage: npm run check
set -euo pipefail
cd "$(dirname "$0")/.."

manifest=crates/pty-host/Cargo.toml

cargo test --manifest-path "$manifest"
# The Node integration suites run this binary and skip themselves when it is missing.
cargo build --release --manifest-path "$manifest"

log=$(mktemp)
trap 'rm -f "$log"' EXIT
# Force TAP: the summary below is parsed, and node's default reporter depends on
# the node version (>=23 prints the spec format even when piped) and on whether
# stdout is a terminal.
TEST_REPORTER=tap npm test 2>&1 | tee "$log"

# A skipped integration suite is a silent pass, so treat any skip as a failure.
# A suite skipped with describe({ skip }) prints "# SKIP" on its own line but is
# not counted in the "# skipped" summary, so check for both.
if grep -q '# SKIP' "$log" || ! grep -q '^# skipped 0$' "$log"; then
  echo "check: tests were skipped; the integration suites need the pty-host binary and dist/" >&2
  exit 1
fi

# The web client is outside tsconfig.node.json, so bundling it is its only gate.
npx react-router build
