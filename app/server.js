// app/server.js
// QuickBite HTTP API (Assignment 2 version).
//
// Application endpoints (see openapi.yaml for the full contract):
//   POST   /orders             place an order            201 | 400 | 422 | 429? | 503
//   GET    /orders             list orders (paginated)   200 | 400 | 429  <- rate limited
//   GET    /orders/{id}        fetch one order           200 | 404
//   PATCH  /orders/{id}        change status             200 | 400 | 404 | 409
//   GET    /health, GET /metrics                         (not part of the API contract)
//   POST   /admin/fault        test hook for failure experiments (Part E.1 / A2 reliability demo)
//
// All business rules live in shared/orderService.js and are shared with the
// gRPC service. This file only does HTTP: parsing, status codes, headers.

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../shared/logger');
const { createDb } = require('../shared/db');
const { createOrderService } = require('../shared/orderService');
const { DomainError } = require('../shared/errors');
const { rateLimit } = require('./rateLimit');
const M = require('./metrics');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://quickbite:quickbite@localhost:5432/quickbite';
const LOG_FILE = process.env.LOG_FILE || '/app/logs/quickbite.log';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10000);
const ADMIN_FAULT_ENABLED = process.env.ADMIN_FAULT_ENABLED !== 'false';

const logger = createLogger('quickbite-api', LOG_FILE);

// Metrics need the DB (orders_pending) and the DB needs metrics (query timing),
// so create the shared metrics first and give the gauge a lazy reference.
let orderService;
const metrics = M.createBusinessMetrics({ countPending: () => orderService.countPending() });
const db = createDb({ connectionString: DATABASE_URL, metrics, logger });
orderService = createOrderService({ db, logger, metrics });

const app = express();
app.disable('x-powered-by');

// ---------- Fault injection state (A1 Part E.1, extended in A2) ----------
//   enabled/everyNth/delayMs : A1 behaviour - every Nth POST /orders is delayed
//   failNext                 : the next N POST /orders return 503 (injected outage)
//   slowNext                 : the next N POST /orders are delayed by delayMs (injected slowness)
const fault = { enabled: false, everyNth: 5, delayMs: 500, counter: 0, failNext: 0, slowNext: 0 };

// ---------- Helpers ----------
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

// One error shape for every failure:
//   { "error": { "code", "message", "details"?, "requestId", ...extra } }
function sendError(req, res, status, code, message, details, extra = {}) {
  res.locals.errorCode = code;
  const error = { code, message, ...(details ? { details } : {}), requestId: req.requestId, ...extra };
  return res.status(status).json({ error });
}

const DOMAIN_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
};

function isDbUnavailable(err) {
  return (
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(err.code) ||
    /^(08|57)/.test(String(err.code || '')) ||
    /timeout exceeded when trying to connect|Connection terminated|Connection refused/i.test(err.message || '')
  );
}

// Wraps async route handlers so a thrown DomainError becomes the right HTTP response.
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof DomainError) {
      return sendError(req, res, DOMAIN_STATUS[err.code] || 400, err.code, err.message, err.details);
    }
    if (isDbUnavailable(err)) {
      logger.error('database unavailable', { requestId: req.requestId, error: err.message });
      return sendError(req, res, 503, 'DEPENDENCY_UNAVAILABLE', 'the database is temporarily unavailable');
    }
    return next(err);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Middleware: request id + metrics + structured request logging ----------
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && ID_RE.test(incoming) ? incoming : uuidv4();
  res.set('X-Request-ID', req.requestId);
  const start = process.hrtime.bigint();
  M.httpRequestsInFlight.inc();

  res.on('close', () => {
    M.httpRequestsInFlight.dec();
  });

  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const routeLabel = req.route ? req.baseUrl + req.route.path : 'unmatched';
    const labels = { method: req.method, route: routeLabel, status_code: res.statusCode };

    M.httpRequestDuration.observe(labels, durationSec);
    M.httpRequestsTotal.inc(labels);

    logger.info('request completed', {
      requestId: req.requestId,
      method: req.method,
      route: routeLabel,
      statusCode: res.statusCode,
      durationMs: Math.round(durationSec * 1000),
      ...(res.locals.errorCode ? { errorCode: res.locals.errorCode } : {}),
    });
  });

  next();
});


// ---------- CORS (only so the Swagger UI container on :8081 can "Try it out") ----------
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:8081';
app.use((req, res, next) => {
  if (req.headers.origin === CORS_ORIGIN) {
    res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Request-ID');
    res.set('Access-Control-Expose-Headers',
      'Location, Idempotent-Replayed, X-Request-ID, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

app.use(express.json({ limit: '100kb' }));

// ---------- Operational endpoints (excluded from the API contract) ----------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', M.register.contentType);
  res.end(await M.register.metrics());
});

// ---------- POST /orders : place an order ----------
app.post(
  '/orders',
  route(async (req, res) => {
    // Injected failures (test hook) - applied before any business logic.
    if (fault.failNext > 0) {
      fault.failNext -= 1;
      logger.warn('fault injection: returning 503', { requestId: req.requestId });
      return sendError(req, res, 503, 'SERVICE_UNAVAILABLE', 'injected failure (fault experiment)');
    }
    if (fault.slowNext > 0) {
      fault.slowNext -= 1;
      logger.warn('fault injection: delaying request', { requestId: req.requestId, delayMs: fault.delayMs });
      await sleep(fault.delayMs);
    } else if (fault.enabled) {
      fault.counter += 1;
      if (fault.counter % fault.everyNth === 0) {
        logger.warn('fault injection: delaying request', { requestId: req.requestId, delayMs: fault.delayMs });
        await sleep(fault.delayMs);
      }
    }

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : req.body;
    const headerKey = req.get('Idempotency-Key');
    if (headerKey !== undefined && body && typeof body === 'object') body.idempotencyKey = headerKey;

    const { order, replayed } = await orderService.placeOrder(body, { requestId: req.requestId });
    if (replayed) res.set('Idempotent-Replayed', 'true');
    res.set('Location', `/orders/${order.id}`);
    return res.status(201).json(order);
  })
);

// ---------- GET /orders : list (paginated, rate limited) ----------
const listLimiter = rateLimit({
  name: 'list-orders',
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  onLimited: () => M.httpRateLimited.inc({ route: '/orders' }),
  sendError,
});

app.get(
  '/orders',
  listLimiter,
  route(async (req, res) => {
    const details = [];
    const { status } = req.query;
    if (status !== undefined && !['placed', 'ready', 'cancelled'].includes(status)) {
      details.push({ field: 'status', issue: 'must be one of: placed, ready, cancelled' });
    }
    const parseInt10 = (name, def, min, max) => {
      const raw = req.query[name];
      if (raw === undefined) return def;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        details.push({ field: name, issue: `must be an integer between ${min} and ${max}` });
        return def;
      }
      return n;
    };
    const limit = parseInt10('limit', 50, 1, 100);
    const offset = parseInt10('offset', 0, 0, 1000000);
    if (details.length) {
      return sendError(req, res, 400, 'VALIDATION_ERROR', 'invalid query parameters', details);
    }

    const { data, total } = await orderService.listOrders({ status, limit, offset });
    return res.json({ data, pagination: { limit, offset, total } });
  })
);

// ---------- GET /orders/:id ----------
app.get(
  '/orders/:id',
  route(async (req, res) => res.json(await orderService.getOrder(req.params.id)))
);

// ---------- PATCH /orders/:id : change status (replaces POST /orders/:id/ready|cancel) ----------
app.patch(
  '/orders/:id',
  route(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { order } = await orderService.changeStatus(req.params.id, body.status, { requestId: req.requestId });
    return res.json(order);
  })
);

// ---------- POST /admin/fault : test hook (validated like any other input) ----------
app.post(
  '/admin/fault',
  route(async (req, res) => {
    if (!ADMIN_FAULT_ENABLED) return sendError(req, res, 404, 'NOT_FOUND', 'not found');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const details = [];
    const posInt = (name, min) => {
      if (body[name] === undefined) return undefined;
      if (!Number.isInteger(body[name]) || body[name] < min) {
        details.push({ field: name, issue: `must be an integer >= ${min}` });
        return undefined;
      }
      return body[name];
    };
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      details.push({ field: 'enabled', issue: 'must be a boolean' });
    }
    const everyNth = posInt('everyNth', 1);
    const delayMs = posInt('delayMs', 0);
    const failNext = posInt('failNext', 0);
    const slowNext = posInt('slowNext', 0);
    if (details.length) return sendError(req, res, 400, 'VALIDATION_ERROR', 'invalid fault configuration', details);

    if (typeof body.enabled === 'boolean') {
      fault.enabled = body.enabled;
      if (!body.enabled) {
        fault.failNext = 0;
        fault.slowNext = 0;
      }
    }
    if (everyNth !== undefined) fault.everyNth = everyNth;
    if (delayMs !== undefined) fault.delayMs = delayMs;
    if (failNext !== undefined) fault.failNext = failNext;
    if (slowNext !== undefined) fault.slowNext = slowNext;
    fault.counter = 0;

    logger.info('fault config updated', { requestId: req.requestId, fault });
    return res.json({ fault });
  })
);

// ---------- 404 + error handlers (always the same error shape) ----------
app.use((req, res) => sendError(req, res, 404, 'NOT_FOUND', `no route for ${req.method} ${req.path}`));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return sendError(req, res, 400, 'INVALID_JSON', 'request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'request body is too large (max 100kb)');
  }
  logger.error('unhandled error', { requestId: req.requestId, error: err.message });
  return sendError(req, res, 500, 'INTERNAL_ERROR', 'internal server error'); // never leak internals
});

const server = app.listen(PORT, () => {
  logger.info('quickbite-api started', { port: PORT, rateLimit: `${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW_MS}ms` });
  // eslint-disable-next-line no-console
  console.log(`QuickBite API listening on :${PORT}`);
});

function shutdown() {
  server.close(() => db.pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
