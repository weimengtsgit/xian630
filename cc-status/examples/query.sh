#!/usr/bin/env bash
# Examples for querying the cc-status API. Usage: ./examples/query.sh
set -euo pipefail

BASE="${CC_STATUS_BASE:-http://127.0.0.1:8765}"

echo "== /healthz =="
curl -s "$BASE/healthz"; echo

echo "== /running (everything live) =="
curl -s "$BASE/running" | head -c 2000; echo

echo "== sessions =="
curl -s "$BASE/api/v1/sessions?limit=5"; echo

echo "== running subagents =="
curl -s "$BASE/api/v1/agents?status=running"; echo

echo "== skills =="
curl -s "$BASE/api/v1/skills?limit=5"; echo

echo "== one session detail (replace <id>) =="
# ID="${1:-}"; [ -n "$ID" ] && curl -s "$BASE/api/v1/sessions/$ID"; echo

echo "== live event stream (SSE, 8s) =="
timeout 8 curl -sN "$BASE/api/v1/events" || true
