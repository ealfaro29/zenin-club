-- Social order fulfillment: pickup completion and courier delivery confirmation.
-- Apply after 0017. Not deployed.
ALTER TABLE zc_social_orders ADD COLUMN delivered_at TEXT;
-- Rebuild status CHECK to permit delivered, retaining records and foreign keys.
PRAGMA foreign_keys=OFF;
CREATE TABLE zc_social_orders_next (
 id TEXT PRIMARY KEY,
 quote_id TEXT NOT NULL UNIQUE REFERENCES zc_quotes(id),
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 status TEXT NOT NULL DEFAULT 'new'
  CHECK(status IN ('new','preparing','ready','shipped','delivered','cancelled')),
 tracking_hash TEXT NOT NULL,
 order_json TEXT NOT NULL CHECK(json_valid(order_json)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 delivered_at TEXT
);
INSERT INTO zc_social_orders_next SELECT id,quote_id,request_id,status,tracking_hash,order_json,created_at,updated_at,delivered_at FROM zc_social_orders;
DROP TABLE zc_social_orders;
ALTER TABLE zc_social_orders_next RENAME TO zc_social_orders;
CREATE INDEX zc_social_orders_request ON zc_social_orders(request_id,created_at);
PRAGMA foreign_keys=ON;
