// shared/db.js
// Postgres access. Every query goes through timedQuery() so db_query_duration_seconds
// is recorded the same way in both services.

const { Pool } = require('pg');

function createDb({ connectionString, metrics, logger }) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: 2000, // fail fast -> HTTP 503 / gRPC UNAVAILABLE instead of hanging
  });
  pool.on('error', (err) => logger.error('postgres pool error', { error: err.message }));

  // `executor` is either the pool or a checked-out client (inside a transaction).
  async function timedQuery(operation, text, params, executor = pool) {
    const end = metrics.dbQueryDuration.startTimer({ operation });
    try {
      return await executor.query(text, params);
    } finally {
      end();
    }
  }

  return { pool, timedQuery };
}

module.exports = { createDb };
