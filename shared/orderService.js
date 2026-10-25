// shared/orderService.js
// THE business rules and the ONLY code that touches the orders tables.
// The HTTP service and the gRPC service both call into this module, so
// "same business rules, same source of truth" holds by construction:
//
//   HTTP  POST /orders  ->  app/server.js        -+
//                                                  +->  orderService.placeOrder()  ->  Postgres
//   gRPC  PlaceOrder    ->  grpc-service/server.js-+

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { validatePlaceOrder } = require('./validation');
const {
  ValidationError,
  NotFoundError,
  ConflictError,
  IdempotencyKeyReuseError,
} = require('./errors');

const ORDER_ID_RE = /^o_[a-f0-9]{12}$/;
const TARGET_STATUSES = ['ready', 'cancelled'];

function rowToOrder(r) {
  return {
    id: r.id,
    customerRef: r.customer_ref,
    items: r.items,
    amount: r.amount_cents / 100,
    status: r.status,
    placedAt: new Date(r.placed_at).toISOString(),
    readyAt: r.ready_at ? new Date(r.ready_at).toISOString() : null,
  };
}

function hashRequest({ customerRef, items }) {
  return crypto.createHash('sha256').update(JSON.stringify({ customerRef, items })).digest('hex');
}

function createOrderService({ db, logger, metrics }) {
  const { pool, timedQuery } = db;

  async function insertOrder(v, executor) {
    const id = `o_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const { rows } = await timedQuery(
      'insert_order',
      `INSERT INTO orders (id, customer_ref, items, amount_cents, status)
       VALUES ($1, $2, $3::jsonb, $4, 'placed') RETURNING *`,
      [id, v.customerRef, JSON.stringify(v.items), v.amountCents],
      executor
    );
    return rows[0];
  }

  // ---- place order (idempotent when a key is supplied) -------------------
  async function placeOrder(input, ctx = {}) {
    const { requestId } = ctx;

    let v;
    try {
      v = validatePlaceOrder(input);
    } catch (err) {
      if (err instanceof ValidationError) {
        metrics.ordersRejected.inc({ reason: 'validation' });
        logger.warn('order rejected: validation failed', {
          requestId,
          fields: (err.details || []).map((d) => d.field),
        });
      }
      throw err;
    }

    // No key: plain insert. A retry of this request WOULD create a second order.
    if (!v.idempotencyKey) {
      const row = await insertOrder(v, pool);
      return afterCreate(row, v, requestId, false);
    }

    // Key supplied: the PRIMARY KEY on idempotency_keys serialises concurrent retries.
    const reqHash = hashRequest(v);
    const client = await pool.connect();
    try {
      await timedQuery('begin', 'BEGIN', [], client);
      const claim = await timedQuery(
        'claim_idempotency_key',
        `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING RETURNING key`,
        [v.idempotencyKey, reqHash],
        client
      );

      if (claim.rowCount === 1) {
        const row = await insertOrder(v, client);
        await timedQuery(
          'link_idempotency_key',
          'UPDATE idempotency_keys SET order_id = $2 WHERE key = $1',
          [v.idempotencyKey, row.id],
          client
        );
        await timedQuery('commit', 'COMMIT', [], client);
        return afterCreate(row, v, requestId, false);
      }

      // Key already used: replay the stored result (or reject a different body).
      await timedQuery('commit', 'COMMIT', [], client);
      const { rows } = await timedQuery(
        'get_idempotency_key',
        `SELECT k.request_hash, o.* FROM idempotency_keys k
         JOIN orders o ON o.id = k.order_id WHERE k.key = $1`,
        [v.idempotencyKey]
      );
      const existing = rows[0];
      if (!existing || existing.request_hash !== reqHash) {
        metrics.ordersRejected.inc({ reason: 'idempotency_conflict' });
        logger.warn('order rejected: idempotency key reused with different body', { requestId });
        throw new IdempotencyKeyReuseError();
      }
      metrics.idempotentReplays.inc();
      logger.info('order replayed from idempotency key', { requestId, orderId: existing.id });
      return { order: rowToOrder(existing), replayed: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function afterCreate(row, v, requestId, replayed) {
    metrics.ordersTotal.inc({ status: 'placed' });
    logger.info('order placed', {
      requestId,
      orderId: row.id,
      itemCount: v.items.length,
      amount: row.amount_cents / 100,
    });
    return { order: rowToOrder(row), replayed };
  }

  // ---- reads --------------------------------------------------------------
  async function getOrder(id) {
    if (!ORDER_ID_RE.test(id || '')) throw new NotFoundError();
    const { rows } = await timedQuery('get_order', 'SELECT * FROM orders WHERE id = $1', [id]);
    if (rows.length === 0) throw new NotFoundError();
    return rowToOrder(rows[0]);
  }

  async function listOrders({ status, limit = 50, offset = 0 } = {}) {
    const where = status ? 'WHERE status = $1' : '';
    const args = status ? [status] : [];
    const [{ rows }, count] = await Promise.all([
      timedQuery(
        'list_orders',
        `SELECT * FROM orders ${where} ORDER BY placed_at DESC, id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset]
      ),
      timedQuery('count_orders', `SELECT count(*)::int AS n FROM orders ${where}`, args),
    ]);
    return { data: rows.map(rowToOrder), total: count.rows[0].n };
  }

  async function countPending() {
    const { rows } = await timedQuery(
      'count_pending',
      "SELECT count(*)::int AS n FROM orders WHERE status = 'placed'",
      []
    );
    return rows[0].n;
  }

  // ---- state transitions: placed -> ready | cancelled ----------------------
  // Repeating the same transition is a harmless no-op (idempotent); trying a
  // different one from a terminal state is a conflict.
  async function changeStatus(id, target, ctx = {}) {
    const { requestId } = ctx;
    if (!TARGET_STATUSES.includes(target)) {
      throw new ValidationError('request validation failed', [
        { field: 'status', issue: `must be one of: ${TARGET_STATUSES.join(', ')}` },
      ]);
    }
    if (!ORDER_ID_RE.test(id || '')) throw new NotFoundError();

    const { rows } = await timedQuery(
      'transition_order',
      `UPDATE orders
          SET status = $2, ready_at = CASE WHEN $2 = 'ready' THEN now() ELSE ready_at END
        WHERE id = $1 AND status = 'placed'
        RETURNING *, EXTRACT(EPOCH FROM (now() - placed_at))::float8 AS processing_seconds`,
      [id, target]
    );

    if (rows.length === 1) {
      metrics.ordersTotal.inc({ status: target });
      if (target === 'ready' && metrics.orderProcessing) {
        metrics.orderProcessing.observe(rows[0].processing_seconds);
      }
      logger.info(target === 'ready' ? 'order ready' : 'order cancelled', {
        requestId,
        orderId: id,
        ...(target === 'ready' ? { processingSeconds: rows[0].processing_seconds } : {}),
      });
      return { order: rowToOrder(rows[0]), changed: true };
    }

    const current = await getOrder(id); // throws NotFoundError if missing
    if (current.status === target) return { order: current, changed: false };
    logger.warn('order status change rejected', { requestId, orderId: id, from: current.status, to: target });
    throw new ConflictError(`order is ${current.status}, cannot change to ${target}`);
  }

  return { placeOrder, getOrder, listOrders, countPending, changeStatus };
}

module.exports = { createOrderService, rowToOrder };
