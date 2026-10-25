// app/metrics.js
// HTTP-service metrics. Business/dependency metrics shared with the gRPC
// service live in shared/metrics.js; this file adds the HTTP-specific ones.
//
//   http_request_duration_seconds{method,route,status_code}  histogram
//   http_requests_total{method,route,status_code}            counter
//   http_requests_in_flight                                   gauge     (A2)
//   http_rate_limited_total{route}                            counter   (A2)
//   demo_requests_total{request_id}                           counter   (A1 cardinality experiment only)
//
// A2 changes vs A1:
//   * histogram buckets now start at 1 ms (A1 started at 10 ms, which hid the
//     real shape of a few-millisecond API and made p50 meaningless)
//   * route label uses "unmatched" for 404s (A1 fell back to the raw URL path,
//     which let any scanner create unlimited label values)

const client = require('prom-client');
const { createBusinessMetrics } = require('../shared/metrics');

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const HTTP_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: HTTP_BUCKETS,
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'HTTP requests currently being handled',
  registers: [register],
});

const httpRateLimited = new client.Counter({
  name: 'http_rate_limited_total',
  help: 'Requests rejected with 429 by the rate limiter',
  labelNames: ['route'],
  registers: [register],
});

// Part E.2 cardinality-explosion demo metric (unchanged from A1, still isolated).
const cardinalityDemoRequests = new client.Counter({
  name: 'demo_requests_total',
  help: 'Demo counter used to illustrate cardinality explosion when labeled by request_id',
  labelNames: ['request_id'],
  registers: [register],
});

module.exports = {
  register,
  createBusinessMetrics: (opts) => createBusinessMetrics(register, opts),
  httpRequestDuration,
  httpRequestsTotal,
  httpRequestsInFlight,
  httpRateLimited,
  cardinalityDemoRequests,
};
