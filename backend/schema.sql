PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  tracking_hash TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'preparing', 'ready', 'shipped', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  order_json TEXT NOT NULL CHECK (json_valid(order_json))
);

CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
