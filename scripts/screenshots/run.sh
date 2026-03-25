#!/bin/bash
set -euo pipefail

# Capture and annotate relay-tty mobile screenshots.
# Prereqs: relay-tty server running on localhost:7680 with at least one session.
#
# Usage:
#   ./scripts/screenshots/run.sh [session_id]
#   npm run docs:screenshots [-- session_id]

BASE_URL="${RELAY_SCREENSHOT_URL:-http://localhost:7680}"

SESSION_ID="${1:-$(curl -sf "${BASE_URL}/api/sessions" | python3 -c 'import sys,json;ss=json.load(sys.stdin);print(ss[0]["id"] if ss else "")' 2>/dev/null || true)}"

if [ -z "$SESSION_ID" ]; then
  echo "Error: No sessions found. Start the server and create a session first:" >&2
  echo "  relay bash          # create a session" >&2
  echo "  relay server start  # start the web server" >&2
  exit 1
fi

echo "Using session: $SESSION_ID" >&2
echo "Server: $BASE_URL" >&2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$SCRIPT_DIR"

# Capture raw screenshots
uv run --project "$PROJECT_ROOT" --extra screenshots \
  python capture.py \
  --session-id "$SESSION_ID" \
  --base-url "$BASE_URL" \
  --output _raw/ \
  --manifest manifest.json

# Annotate and save to website
uv run --project "$PROJECT_ROOT" --extra screenshots \
  python annotate.py \
  --raw _raw/ \
  --manifest manifest.json \
  --output "$PROJECT_ROOT/docs/public/images/mobile/"

echo "" >&2
echo "Screenshots saved to docs/public/images/mobile/" >&2
ls -la "$PROJECT_ROOT/docs/public/images/mobile/"*.png 2>/dev/null | awk '{print "  " $NF}' >&2
