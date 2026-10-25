// shared/metrics.js
// Business + dependency metrics that BOTH services need. Each process has its
// own prom-client registry (it is scraped as its own Prometheus job), so we
// build the metrics from a factory instead of a module-level singleton.
//
//   orders_total{status}              counter   placed | ready | cancelled
//   orders_rejected_total{reason}     counter   validation | idempotency_conflict   (A2)
//   idempotent_replays_total          counter   retries answered from a stored result (A2)
//   db_query_duration_seconds{op}     histogram time spent in Postgres per operation   (A2)
//   orders_pending                    gauge     (HTTP service only) read from the DB at scrape time
//   order_processing_seconds          summary   (HTTP service only) placed -> ready

const client = require('prom-client');

const DB_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

function createBusinessMetrics(register, { countPending } = {}) {
  const ordersTotal = new client.Counter({
    name: 'orders_total',
    help: 'Total number of order state changes, labeled by outcome',
    labelNames: ['status'], // placed | ready | cancelled
    registers: [register],
  });

  const ordersRejected = new client.Counter({
    name: 'orders_rejected_total',
    help: 'Order requests rejected by business rules, labeled by reason',
    labelNames: ['reason'], // validation | idempotency_conflict  (bounded)
    registers: [register],
  });

  const idempotentReplays = new client.Counter({
    name: 'idempotent_replays_total',
    help: 'Place-order requests answered from a stored idempotent result instead of creating a new order',
    registers: [register],
  });

  const dbQueryDuration = new client.Histogram({
    name: 'db_query_duration_seconds',
    help: 'Duration of Postgres operations in seconds',
    labelNames: ['operation'], // insert_order | get_order | list_orders | transition_order | ... (bounded)
    buckets: DB_BUCKETS,
    registers: [register],
  });

  const metrics = { ordersTotal, ordersRejected, idempotentReplays, dbQueryDuration };

  if (countPending) {
    // A1 kept this gauge with .inc()/.dec() in memory. That breaks as soon as a
    // second process can create orders (the gRPC service) or the app restarts.
    // Now it is computed from the database each time Prometheus scrapes.
    metrics.ordersPending = new client.Gauge({
      name: 'orders_pending',
      help: 'Number of orders currently waiting to be prepared (read from the database)',
      registers: [register],
      async collect() {
        try {
          this.set(await countPending());
        } catch (_err) {
          /* keep the previous value if the DB is briefly unreachable */
        }
      },
    });

    metrics.orderProcessing = new client.Summary({
      name: 'order_processing_seconds',
      help: 'Time an order spends being prepared, from placement to ready',
      percentiles: [0.5, 0.9, 0.95, 0.99],
      registers: [register],
    });
  }

  return metrics;
}

module.exports = { createBusinessMetrics, DB_BUCKETS };
