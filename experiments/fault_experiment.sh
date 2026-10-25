#!/usr/bin/env bash
# fault_experiment.sh
# Part E.1 - Reproduce a problem: inject a 500ms delay on every 5th /orders
# request, and show it in the histogram + logs.
#
# Stages:
#   1. BEFORE - fault disabled, run load, this is the healthy baseline.
#   2. DURING - fault enabled (every 5th request delayed by 500ms), run load.
#   3. AFTER  - fault disabled again, run load, confirm recovery.
#
# Each stage runs long enough (30s at 5 req/s = ~150 requests) to cross
# several Prometheus scrape intervals (scrape_interval: 5s in our config).
#
# Usage: ./fault_experiment.sh [BASE_URL]

set -euo pipefail
BASE_URL="${1:-http://localhost:3000}"
STAGE_SECONDS=30
RPS=5

echo "== Stage 1/3: BEFORE (no fault) =========================="
curl -s -X POST "$BASE_URL/admin/fault" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
echo
node "$(dirname "$0")/load_generator.js" $STAGE_SECONDS $RPS
echo "Note the time range just printed - screenshot Grafana's"
echo "'HTTP request latency - p95/p99' panel for this window as BEFORE."
sleep 2

echo
echo "== Stage 2/3: DURING (fault: every 5th request +500ms) ===="
curl -s -X POST "$BASE_URL/admin/fault" -H "Content-Type: application/json" \
  -d '{"enabled": true, "everyNth": 5, "delayMs": 500}'
echo
node "$(dirname "$0")/load_generator.js" $STAGE_SECONDS $RPS
echo "Screenshot the same panel for this window as DURING - you should"
echo "see p95/p99 for POST /orders jump, and 'fault injection: delaying"
echo "request' warnings in Kibana for this time range."
sleep 2

echo
echo "== Stage 3/3: AFTER (fault removed) ========================"
curl -s -X POST "$BASE_URL/admin/fault" -H "Content-Type: application/json" \
  -d '{"enabled": false}'
echo
node "$(dirname "$0")/load_generator.js" $STAGE_SECONDS $RPS
echo "Screenshot the same panel for this window as AFTER - latency should"
echo "drop back to baseline, confirming recovery."

echo
echo "Experiment complete. Suggested Grafana query for the write-up:"
echo '  histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/orders"}[1m])))'
