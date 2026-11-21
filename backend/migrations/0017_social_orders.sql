-- Separate social orders from legacy checkout inventory triggers.
-- Apply after migrations 0012-0016. Not deployed.
CREATE TABLE IF NOT EXISTS zc_social_orders (
 id TEXT PRIMARY KEY,
 quote_id TEXT NOT NULL UNIQUE REFERENCES zc_quotes(id),
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','preparing','ready','shipped','delivered','cancelled')),
 tracking_hash TEXT NOT NULL,
 order_json TEXT NOT NULL CHECK(json_valid(order_json)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS zc_social_orders_request ON zc_social_orders(request_id,created_at);
