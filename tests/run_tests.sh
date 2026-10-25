#!/usr/bin/env bash
# Runs every test. The stack must be up first:  docker compose up -d --build
# (the rate-limit test deliberately waits ~25 s for fresh rate-limit windows)
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== Node unit tests (business rules, no DB needed) =="
node --test shared/test/*.test.js
echo
echo "== OpenAPI document is valid =="
python3 - <<'PY'
import yaml
from openapi_spec_validator import validate
validate(yaml.safe_load(open("openapi.yaml")))
print("openapi.yaml is a valid OpenAPI 3 document")
PY
echo
echo "== Python tests: caller unit tests, HTTP contract tests, gRPC + parity tests =="
python3 -m unittest discover -s tests -v
