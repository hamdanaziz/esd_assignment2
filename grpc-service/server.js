// grpc-service/server.js
// QuickBite gRPC service - a separate process/container exposing PlaceOrder.
//
// It does NOT call the HTTP API. It calls the same shared/orderService.js
// (same validation, same idempotency logic, same Postgres tables), so both
// front doors enforce identical business rules against one source of truth.
//
// Call path:
//   client stub -> HTTP/2 -> grpc-js server -> instrument() wrapper (request id,
//   metrics, logging, error mapping) -> PlaceOrder handler -> orderService -> Postgres
//
// Observability:
//   * logs      : same JSON format as the HTTP service (app_name = quickbite-grpc);
//                 requestId comes from the `x-request-id` metadata key
//   * metrics   : http://<host>:9464/metrics (scraped by Prometheus job `quickbite-grpc`)
//   * test hook : POST :9464/admin/fault {"delayMs": 800}  adds latency to PlaceOrder
//                 (mirrors the HTTP service's /admin/fault)

const path = require('path');
const http = require('http');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const client = require('prom-client');
const { v4: uuidv4 } = require('uuid');

const { createLogger } = require('../shared/logger');
const { createDb } = require('../shared/db');
const { createBusinessMetrics } = require('../shared/metrics');
const { createOrderService } = require('../shared/orderService');
const { DomainError } = require('../shared/errors');

const GRPC_PORT = Number(process.env.GRPC_PORT || 50051);
const METRICS_PORT = Number(process.env.METRICS_PORT || 9464);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://quickbite:quickbite@localhost:5432/quickbite';
const LOG_FILE = process.env.LOG_FILE || '/app/logs/quickbite-grpc.log';
const PROTO_PATH = process.env.PROTO_PATH || path.join(__dirname, '..', 'proto', 'orders.proto');

const logger = createLogger('quickbite-grpc', LOG_FILE);

// ---------------- metrics ----------------
// Duration is measured SERVER-side: from the moment the handler wrapper starts
// until the response (or error) is handed back to grpc-js.
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const GRPC_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

const handledTotal = new client.Counter({
  name: 'grpc_server_handled_total',
  help: 'Total RPCs completed on the server, by method and gRPC status code',
  labelNames: ['grpc_method', 'grpc_code'],
  registers: [register],
});
const handlingSeconds = new client.Histogram({
  name: 'grpc_server_handling_seconds',
  help: 'Server-side RPC duration in seconds, by method and gRPC status code',
  labelNames: ['grpc_method', 'grpc_code'],
  buckets: GRPC_BUCKETS,
  registers: [register],
});
const inFlight = new client.Gauge({
  name: 'grpc_server_in_flight_requests',
  help: 'RPCs currently being handled by the server',
  labelNames: ['grpc_method'],
  registers: [register],
});

const metrics = createBusinessMetrics(register); // orders_total, db_query_duration_seconds, ...
const db = createDb({ connectionString: DATABASE_URL, metrics, logger });
const orderService = createOrderService({ db, logger, metrics });

// ---------------- error mapping: domain error -> gRPC status ----------------
const DOMAIN_TO_GRPC = {
  VALIDATION_ERROR: grpc.status.INVALID_ARGUMENT, // HTTP 400
  NOT_FOUND: grpc.status.NOT_FOUND, //                HTTP 404
  CONFLICT: grpc.status.FAILED_PRECONDITION, //       HTTP 409
  IDEMPOTENCY_KEY_REUSED: grpc.status.FAILED_PRECONDITION, // HTTP 422
};

function isDbUnavailable(err) {
  return (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err.code) ||
    /^(08|57)/.test(String(err.code || '')) ||
    /timeout exceeded when trying to connect|Connection terminated|Connection refused/i.test(err.message || '')
  );
}

function toGrpcError(err, requestId) {
  const metadata = new grpc.Metadata();
  metadata.set('x-request-id', requestId);
  if (err instanceof DomainError) {
    metadata.set('x-error-code', err.code);
    const fields = (err.details || []).map((d) => `${d.field}: ${d.issue}`).join('; ');
    return { code: DOMAIN_TO_GRPC[err.code] || grpc.status.INVALID_ARGUMENT, details: fields ? `${err.message} (${fields})` : err.message, metadata };
  }
  if (isDbUnavailable(err)) {
    return { code: grpc.status.UNAVAILABLE, details: 'the database is temporarily unavailable', metadata };
  }
  logger.error('unhandled grpc error', { requestId, error: err.message });
  return { code: grpc.status.INTERNAL, details: 'internal server error', metadata }; // never leak internals
}

// ---------------- fault injection (test hook) ----------------
const fault = { delayMs: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- the instrumentation wrapper (acts like a server interceptor) ----------------
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function instrument(method, handler) {
  return async (call, callback) => {
    const start = process.hrtime.bigint();
    const incoming = call.metadata.get('x-request-id')[0];
    const requestId = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : uuidv4();

    const initial = new grpc.Metadata();
    initial.set('x-request-id', requestId);
    call.sendMetadata(initial);

    inFlight.inc({ grpc_method: method });
    let code = grpc.status.OK;
    let errorCode;
    try {
      const response = await handler(call.request, { requestId });
      callback(null, response);
    } catch (err) {
      const e = toGrpcError(err, requestId);
      code = e.code;
      errorCode = err instanceof DomainError ? err.code : undefined;
      callback(e);
    } finally {
      const sec = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { grpc_method: method, grpc_code: grpc.status[code] }; // e.g. "OK", "INVALID_ARGUMENT"
      inFlight.dec({ grpc_method: method });
      handledTotal.inc(labels);
      handlingSeconds.observe(labels, sec);
      logger.info('grpc call completed', {
        requestId,
        grpcMethod: method,
        grpcCode: grpc.status[code],
        durationMs: Math.round(sec * 1000),
        ...(errorCode ? { errorCode } : {}),
      });
    }
  };
}

// ---------------- handlers ----------------
async function placeOrder(request, ctx) {
  if (fault.delayMs > 0) {
    logger.warn('fault injection: delaying request', { requestId: ctx.requestId, delayMs: fault.delayMs });
    await sleep(fault.delayMs);
  }
  // Map the protobuf message to the same plain input the HTTP endpoint produces.
  const input = {
    customerRef: request.customerRef || undefined,
    idempotencyKey: request.idempotencyKey || undefined,
    items: (request.items || []).map((i) => ({ name: i.name, price: i.price, qty: i.qty })),
  };
  const { order, replayed } = await orderService.placeOrder(input, ctx);
  return {
    id: order.id,
    customerRef: order.customerRef,
    items: order.items,
    amount: order.amount,
    status: order.status,
    placedAt: order.placedAt,
    replayed,
  };
}

// ---------------- start servers ----------------
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, // snake_case in .proto -> camelCase in JS
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDefinition).quickbite.v1;

const grpcServer = new grpc.Server();
grpcServer.addService(proto.OrderService.service, {
  PlaceOrder: instrument('PlaceOrder', placeOrder),
});

grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    logger.error('grpc bind failed', { error: err.message });
    process.exit(1);
  }
  logger.info('quickbite-grpc started', { port });
  // eslint-disable-next-line no-console
  console.log(`QuickBite gRPC listening on :${port}, metrics on :${METRICS_PORT}`);
});

// Small HTTP server for Prometheus (/metrics), health and the fault test hook.
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const metricsServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType);
    return res.end(await register.metrics());
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end('{"status":"ok"}');
  }
  if (req.method === 'POST' && req.url === '/admin/fault') {
    let parsed;
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch (_e) {
      res.statusCode = 400;
      return res.end('{"error":"invalid JSON"}');
    }
    if (parsed.delayMs !== undefined) {
      if (!Number.isInteger(parsed.delayMs) || parsed.delayMs < 0) {
        res.statusCode = 400;
        return res.end('{"error":"delayMs must be an integer >= 0"}');
      }
      fault.delayMs = parsed.delayMs;
    }
    logger.info('fault config updated', { fault });
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ fault }));
  }
  res.statusCode = 404;
  return res.end();
});
metricsServer.listen(METRICS_PORT);

function shutdown() {
  grpcServer.tryShutdown(() => {
    metricsServer.close();
    db.pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
