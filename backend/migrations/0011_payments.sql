-- Tilopay payment attempts. Each attempt has its own orderNumber because Tilopay
-- rejects a repeated orderNumber forever. Additive and rerunnable.
CREATE TABLE IF NOT EXISTS payment_attempts (
 order_number TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 amount TEXT NOT NULL,
 currency TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('created', 'approved', 'rejected', 'review', 'error', 'expired', 'refunded')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE INDEX IF NOT EXISTS payment_attempts_order ON payment_attempts(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_status ON payment_attempts(status, created_at);
