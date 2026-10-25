# QuickBite: HTTP API, gRPC service and metrics (Assignment 2)

QuickBite is a small food-ordering service (Node.js). This project has:

- **HTTP API** (Express, port 3000), described by `openapi.yaml`
- **gRPC service** (separate container, port 50051), described by `proto/orders.proto`
- **Postgres**: the single database both services use
- **Observability**: Prometheus + Grafana (metrics), Filebeat + Elasticsearch + Kibana (logs)
- **Python scripts**: a reliable HTTP caller (timeout, retries, circuit breaker), a gRPC client (deadline), demos and tests

Task used for gRPC: **place an order** (`POST /orders` and `OrderService.PlaceOrder`). Both call the same code in `shared/orderService.js` and use the same Postgres tables.

---

## 1. Folder layout

```
app/            HTTP service (server.js, rateLimit.js, HTTP metrics)
grpc-service/   gRPC service (server.js)
shared/         validation, idempotency, database access, logger, shared metrics (used by BOTH services)
proto/          orders.proto
db/init.sql     database tables (orders, idempotency_keys)
openapi.yaml    HTTP API contract
clients/        http_caller.py, grpc_client.py, rate_limit_demo.py, generated/ (protobuf code)
tests/          Python tests + run_tests.sh      (shared/test = Node unit tests)
experiments/    a2_traffic.py (repeatable traffic), load generator, A1 experiments
prometheus/ grafana/ filebeat/ docs/
```

## 2. Ports and logins

| What | Tool | URL / port |
|---|---|---|
| HTTP API | QuickBite app | http://localhost:3000 |
| gRPC API | QuickBite gRPC service | `localhost:50051` (health + metrics: http://localhost:9464) |
| Database | Postgres | 5432 (user / password / db: `quickbite`) |
| API docs and try-it | Swagger UI | http://localhost:8081 |
| Metrics | Prometheus | http://localhost:9090 |
| Dashboards | Grafana (login `admin` / `admin`) | http://localhost:3001 |
| Host metrics | Node Exporter | http://localhost:9100 |
| Logs | Elasticsearch / Kibana | http://localhost:9200 / http://localhost:5601 |

## 3. What you need first

- Docker Desktop (Docker Compose v2) and about 4 GB of free RAM (Elasticsearch needs it)
- Python 3.10 or newer
- Node.js 18 or newer (only for the Node unit tests, which run on your machine and not in Docker)

All commands below are run from the project folder (`quickbite-observability`).

## 4. One-time Python setup

On a Mac the command is `python3`, not `python`. A virtual environment keeps things clean:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r clients/requirements.txt
```

Your prompt should start with `(.venv)`. If you open a new terminal later, run `source .venv/bin/activate` again from the project folder. If you skip the virtual environment, use `python3` in every command.

## 5. Start everything

```bash
docker compose up --build -d
docker compose ps
```

Wait until all containers show `Up` and Postgres shows `(healthy)`. Then check both services:

```bash
curl localhost:3000/health      # HTTP service  -> {"status":"ok"}
curl localhost:9464/health      # gRPC service  -> {"status":"ok"}
```

Open the Prometheus targets page: http://localhost:9090/targets
`quickbite-api`, `quickbite-grpc`, `node-exporter` and `prometheus` must be **UP**. `cardinality-demo` is DOWN on purpose (an Assignment 1 experiment container that is not started).

## 6. Part A: HTTP API

### 6.1 OpenAPI and Swagger UI

Open http://localhost:8081. It shows `openapi.yaml`.
1. Click `POST /orders`, then **Try it out**.
2. Set header `Idempotency-Key` to `swagger-demo-1` and use this body:
   ```json
   {"customerRef":"cust_42","items":[{"name":"Zinger Burger","price":5.5,"qty":2}]}
   ```
3. Click **Execute**. You get `201`.
4. Click **Execute** again with the same key. You get `201` with the header `idempotent-replayed: true` and the same order id.
5. Change the body to `{"items":[{"name":"","price":-1,"qty":0}]}` and execute. You get `400 VALIDATION_ERROR` listing all three bad fields.

### 6.2 curl examples (valid, repeated, invalid)

Place an order, then run the same command again. The second answer has `Idempotent-Replayed: true` and the same id:

```bash
curl -i -X POST localhost:3000/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -H 'X-Request-ID: demo-http-1' \
  -d '{"customerRef":"cust_42","items":[{"name":"Zinger Burger","price":5.5,"qty":2}]}'
```

Invalid input gives `400` and the standard error format:

```bash
curl -i -X POST localhost:3000/orders -H 'Content-Type: application/json' -H 'X-Request-ID: demo-http-2' \
  -d '{"items":[{"name":"","price":-1,"qty":0}]}'
```

Broken JSON also gives `400` (code `INVALID_JSON`):

```bash
curl -i -X POST localhost:3000/orders -H 'Content-Type: application/json' -d '{"items":'
```

### 6.3 Order lifecycle (PATCH)

The first command creates an order and saves its id in a variable `ID`, so you do not copy anything:

```bash
ID=$(curl -s -X POST localhost:3000/orders -H 'Content-Type: application/json' -d '{"customerRef":"cust_42","items":[{"name":"Zinger Burger","price":5.5,"qty":2}]}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "order id: $ID"
```

You should see an id like `o_1c82fc9b116c`. Then:

```bash
curl -i -X PATCH localhost:3000/orders/$ID -H 'Content-Type: application/json' -d '{"status":"ready"}'       # 200, status ready, readyAt set
curl -i -X PATCH localhost:3000/orders/$ID -H 'Content-Type: application/json' -d '{"status":"cancelled"}'   # 409 CONFLICT
curl -i localhost:3000/orders/o_000000000000                                                                  # 404 NOT_FOUND
curl -i -X PATCH localhost:3000/orders/$ID -H 'Content-Type: application/json' -d '{"status":"ready"}'       # 200 again: safe to repeat
```

Do not type the word `ORDER_ID` instead of a real id. That correctly returns 404.

List orders (paginated, rate limited to 10 requests per 10 seconds per client IP):

```bash
curl "localhost:3000/orders?status=placed&limit=20&offset=0"
```

### 6.4 Rate limit demo

```bash
python3 clients/rate_limit_demo.py
```

Expected: requests 1 to 10 return `200` (Remaining 9 down to 0), requests 11 to 13 return `429` with `Retry-After=10s`, the script waits 10 seconds, then requests 14 and 15 return `200`.

### 6.5 Python caller: timeout, retries, circuit breaker

```bash
python3 clients/http_caller.py demo                    # outage = server returns 503
python3 clients/http_caller.py demo --fault timeout    # outage = server is slow, client times out
```

Each run shows four phases: success, retry then success, breaker opens and blocks calls, then recovery.

Settings: timeout 1.0 s, 2 retries (up to 3 attempts) with backoff 0.2 s x 2^n plus jitter, breaker opens after 3 failed calls in a row, recovery period 6 s then one half-open trial call. Retries use the same `Idempotency-Key`, so they cannot create duplicate orders. 4xx and 429 are never retried.

## 7. Part B: gRPC service

### 7.1 Generate the Python gRPC code

Only needed if you change `proto/orders.proto` (the generated files are already in `clients/generated/`):

```bash
./scripts/gen_proto.sh
# this runs:
# python3 -m grpc_tools.protoc -I proto --python_out=clients/generated --grpc_python_out=clients/generated proto/orders.proto
```

The Node gRPC server loads `proto/orders.proto` itself when it starts, so it needs no generated file.

### 7.2 Call the gRPC service

```bash
# success -> grpc status OK (0), replayed=False
python3 clients/grpc_client.py --customer cust_42 --item "Zinger Burger:5.5:2" --item "Fries:2:1" --request-id demo-grpc-1

# invalid input -> INVALID_ARGUMENT (3), error code VALIDATION_ERROR
python3 clients/grpc_client.py --item ":0:0" --request-id demo-grpc-2

# deadline too short -> DEADLINE_EXCEEDED (4)
python3 clients/grpc_client.py --item "Fries:2:1" --deadline 0.001
```

Idempotency over gRPC. Run the same command twice with a fresh key. The first shows `replayed=False`, the second shows the same order id with `replayed=True`:

```bash
python3 clients/grpc_client.py --item "Fries:2:1" --idempotency-key ss12-demo
python3 clients/grpc_client.py --item "Fries:2:1" --idempotency-key ss12-demo
```

Input format is `--item "name:price:qty"`. Options: `--customer`, `--request-id`, `--idempotency-key`, `--deadline` (seconds, default 2.0).

### 7.3 HTTP and gRPC status codes

| Situation | HTTP | gRPC |
|---|---|---|
| Success | `201 Created` | `OK (0)` |
| Invalid input | `400 VALIDATION_ERROR` | `INVALID_ARGUMENT (3)` |
| Same idempotency key, different body | `422` | `FAILED_PRECONDITION (9)` |
| Order not found | `404` | `NOT_FOUND (5)` |
| Database down | `503` | `UNAVAILABLE (14)` |
| Caller gave up waiting | client timeout | `DEADLINE_EXCEEDED (4)` |

### 7.4 Call paths

Diagrams of both paths (HTTP router, and gRPC generated stub, server and handler) are in `docs/architecture.md`.
In short: HTTP goes client -> Express router and middleware -> POST /orders handler -> `shared/orderService.js` -> Postgres. gRPC goes Python client -> generated stub -> grpc-js server -> `instrument()` wrapper -> PlaceOrder handler -> the same `shared/orderService.js` -> Postgres.

### 7.5 Trace ids across HTTP and gRPC (Kibana)

Create the Kibana data view once:
1. Open http://localhost:5601, go to **Stack Management**, **Data views**, **Create data view**.
2. Name and index pattern: `quickbite-logs-*`. Time field: `@timestamp`. Save.

Send one request id to both services:

```bash
curl -s -o /dev/null -X POST localhost:3000/orders -H 'Content-Type: application/json' -H 'X-Request-ID: corr-shared-42' -d '{"items":[{"name":"Fries","price":2,"qty":1}]}'
python3 clients/grpc_client.py --item "Fries:2:1" --request-id corr-shared-42
```

In Kibana **Discover** (time range: last 15 minutes) search:

```
requestId : "corr-shared-42"
```

You see log lines from both `quickbite-api` and `quickbite-grpc` with the same `requestId`. HTTP reads the id from the `X-Request-ID` header and gRPC reads it from the `x-request-id` metadata key.

## 8. Tests

The stack must be running. The script takes about 30 seconds because the rate-limit test waits for fresh windows.

```bash
npm install                 # first time only (Node unit tests)
./tests/run_tests.sh
```

It runs, in order: Node unit tests for the business rules, a check that `openapi.yaml` is valid, then the Python tests (caller unit tests, HTTP contract tests checked against `openapi.yaml`, gRPC tests and HTTP/gRPC parity tests). Expected end: Node `pass 16`, Python `Ran 30 tests ... OK`.

You can also run them separately:

```bash
npm run test:unit                          # Node business-rule tests
python3 -m unittest discover -s tests -v   # Python tests
```

If `./tests/run_tests.sh` says permission denied, run `chmod +x tests/run_tests.sh scripts/gen_proto.sh` first.

## 9. Part C: Metrics

### 9.1 Generate repeatable traffic

```bash
python3 experiments/a2_traffic.py
```

It sends the same mix every run (fixed seed): 70% valid orders, 20% invalid, 10% repeats of an earlier key, at 10 requests per second to HTTP and to gRPC. Phases: 30 s baseline, 30 s with +300 ms delay, 30 s recovery. It prints the status counts at the end (about 707 successes and 173 errors per protocol).

Options: `--rps 10 --baseline 30 --fault 30 --recovery 30 --delay-ms 300`.

### 9.2 Look at the dashboard

1. Open http://localhost:3001 and log in with `admin` / `admin`.
2. Open the dashboard **QuickBite - Observability**.
3. Find the row **Assignment 2 - PlaceOrder over HTTP vs gRPC**. Set the time range to the last 30 minutes to 1 hour.

Panels in that row: calls per second by status (HTTP and gRPC), error rate %, latency p50 / p95 (1 minute window), in-flight calls, DB query p95 by operation, business events per minute (replays, rejections, 429s), and share of calls under 100 ms.

### 9.3 Look at the raw gRPC metrics

```bash
curl -s localhost:9464/metrics | grep -E "^grpc_server_(handled_total|in_flight)"
curl -s localhost:9464/metrics | grep -E "^grpc_server_handling_seconds_(bucket|count)" | head -15
```

### 9.4 New metrics (summary)

| Metric | Type | Unit | Labels |
|---|---|---|---|
| `grpc_server_handled_total` | counter | calls | `grpc_method`, `grpc_code` |
| `grpc_server_handling_seconds` | histogram (1 ms to 2.5 s) | seconds | `grpc_method`, `grpc_code` |
| `grpc_server_in_flight_requests` | gauge | calls | `grpc_method` |
| `http_requests_in_flight` | gauge | requests | none |
| `db_query_duration_seconds` | histogram | seconds | `operation` |
| `idempotent_replays_total` | counter | replays | none |
| `orders_rejected_total` | counter | orders | `reason` |
| `http_rate_limited_total` | counter | requests | `route` |

Duration is measured **at the server**. Labels are bounded: no user, request, order or trace ids are ever used as labels.

Example queries (Prometheus at http://localhost:9090/graph):

```
sum by (grpc_method, grpc_code) (rate(grpc_server_handled_total[1m]))
histogram_quantile(0.5,  sum by (le) (rate(grpc_server_handling_seconds_bucket{grpc_method="PlaceOrder"}[1m])))
histogram_quantile(0.95, sum by (le) (rate(grpc_server_handling_seconds_bucket{grpc_method="PlaceOrder"}[1m])))
sum(grpc_server_in_flight_requests{grpc_method="PlaceOrder"})
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{route="/orders",method="POST"}[1m])))
```

## 10. Optional: Assignment 1 experiments

```bash
chmod +x experiments/*.sh
./experiments/fault_experiment.sh          # before / during / after latency fault on POST /orders
node experiments/load_generator.js 120 5   # load generator (uses PATCH and Idempotency-Key)
```

The cardinality experiment steps are in `docs/running-experiments-checklist.md`.

## 11. Stop and clean up

```bash
docker compose down        # stop and remove containers, keep data
docker compose down -v     # also wipe Postgres, Prometheus, Grafana and Elasticsearch data
```

## 12. Quick fixes

| Problem | Fix |
|---|---|
| `zsh: command not found: python` | Use `python3`, or activate the venv with `source .venv/bin/activate` |
| `ModuleNotFoundError: No module named 'grpc'` or a protobuf version message | Run `pip install -r clients/requirements.txt` again and let it finish (use the venv) |
| pip says "externally managed environment" | Use the virtual environment from section 4 |
| A request returns 404 for your order id | Use a real id from the create response, not the text `ORDER_ID` |
| 429 on `GET /orders` | You went over 10 requests per 10 seconds. Wait for `Retry-After` seconds |
| Elasticsearch or Kibana will not start | Give Docker more memory (4 GB or more) and run `docker compose up -d` again |
| Grafana panels are empty | Run `python3 experiments/a2_traffic.py` and set the time range to the last hour |
