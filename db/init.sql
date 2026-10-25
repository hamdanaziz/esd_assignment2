-- db/init.sql
-- Single source of truth for QuickBite orders. Both the HTTP service and the
-- gRPC service read/write these tables through shared/orderService.js.
-- Mounted into the postgres container's /docker-entrypoint-initdb.d, so it runs
-- once on first start of an empty data volume.

CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  customer_ref  TEXT        NOT NULL,
  items         JSONB       NOT NULL,
  amount_cents  INTEGER     NOT NULL CHECK (amount_cents >= 0),
  status        TEXT        NOT NULL CHECK (status IN ('placed', 'ready', 'cancelled')),
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS orders_status_idx    ON orders (status);
CREATE INDEX IF NOT EXISTS orders_placed_at_idx ON orders (placed_at DESC);

-- Idempotency keys for "place order". The PRIMARY KEY is what makes concurrent
-- retries safe: only one transaction can insert a given key; the others wait,
-- then see the stored result.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT        NOT NULL,
  order_id      TEXT REFERENCES orders (id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
