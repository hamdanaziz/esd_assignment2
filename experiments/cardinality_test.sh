#!/usr/bin/env bash
# cardinality_test.sh
# Part E.2 - Cardinality explosion.
#
# Step 1: run the demo app WITH the request_id label, hit it 100 times
#         (100 unique IDs), and watch the Prometheus series count climb.
# Step 2: restart the demo app WITHOUT the label, hit it 100 times again,
#         and show the series count stays at 1.
#
# Requires the docker-compose stack to be up (Prometheus needs to be able
# to scrape whichever mode the demo app is running in).
#
# Usage: ./cardinality_test.sh

set -euo pipefail
PROM_URL="${PROM_URL:-http://localhost:9090}"
DEMO_URL="${DEMO_URL:-http://localhost:9091}"

query_series_count() {
  curl -s "$PROM_URL/api/v1/query" --data-urlencode 'query=count(demo_requests_total)' \
    | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.result[0]?.value?.[1] ?? '0 (no data yet - wait for next scrape)'"
}

echo "== Step 1: LABELED mode (request_id label) ================"
echo "Start the demo app with: docker compose run --rm -e LABELED=true -p 9091:9091 cardinality-demo"
echo "(or locally: LABELED=true node experiments/cardinality-app/server.js)"
read -p "Press enter once the labeled demo app is running and reachable at $DEMO_URL ..." _

echo "Sending 100 requests, each with a unique request_id label..."
for i in $(seq 1 100); do
  curl -s "$DEMO_URL/hit" > /dev/null
done
echo "Waiting 12s for two Prometheus scrapes..."
sleep 12
echo "Prometheus series count -> count(demo_requests_total):"
query_series_count

echo
echo "== Step 2: UNLABELED mode (no request_id) =================="
echo "Stop the labeled demo app, then start the unlabeled one:"
echo "  docker compose run --rm -e LABELED=false -p 9091:9091 cardinality-demo"
read -p "Press enter once the UNLABELED demo app is running and reachable at $DEMO_URL ..." _

echo "Sending 100 requests again (no label this time)..."
for i in $(seq 1 100); do
  curl -s "$DEMO_URL/hit" > /dev/null
done
echo "Waiting 12s for two Prometheus scrapes..."
sleep 12
echo "Prometheus series count -> count(demo_requests_total):"
query_series_count

echo
echo "Expected result: labeled mode -> ~100 series (one per request_id)."
echo "                 unlabeled mode -> 1 series, count just climbs."
echo "Note for the report: removing a label does NOT delete already-stored"
echo "history - old series remain in Prometheus's TSDB until they expire"
echo "via the configured retention period; only NEW samples stop being"
echo "written under the old high-cardinality series."
