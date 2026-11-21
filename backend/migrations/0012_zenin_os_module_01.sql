-- ZENIN CLUB OS module 01: requests, quotes and manual SINPE payments.
-- Additive migration. Does not alter existing orders, inventory or Tilopay.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS zc_customers (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 phone TEXT,
 email TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zc_requests (
 id TEXT PRIMARY KEY,
 customer_id TEXT NOT NULL REFERENCES zc_customers(id),
 channel TEXT NOT NULL CHECK (channel IN ('whatsapp','instagram','facebook','web','other')),
 status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','accepted','cancelled','converted')),
 description TEXT NOT NULL DEFAULT '',
 source_reference TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zc_requests_customer ON zc_requests(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS zc_requests_status ON zc_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS zc_quotes (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 revision INTEGER NOT NULL CHECK (revision > 0),
 status TEXT NOT NULL CHECK (status IN ('draft','sent','accepted','expired','cancelled','superseded')),
 currency TEXT NOT NULL CHECK (length(currency) = 3),
 subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
 discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
 shipping_minor INTEGER NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
 total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
 deposit_required_minor INTEGER NOT NULL CHECK (deposit_required_minor >= 0),
 expires_at TEXT,
 accepted_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(request_id, revision),
 CHECK (discount_minor <= subtotal_minor),
 CHECK (total_minor = subtotal_minor - discount_minor + shipping_minor),
 CHECK (deposit_required_minor <= total_minor)
);
CREATE INDEX IF NOT EXISTS zc_quotes_request ON zc_quotes(request_id, revision DESC);

CREATE TABLE IF NOT EXISTS zc_quote_items (
 id TEXT PRIMARY KEY,
 quote_id TEXT NOT NULL REFERENCES zc_quotes(id),
 position INTEGER NOT NULL CHECK (position >= 0),
 description TEXT NOT NULL,
 design_id TEXT,
 variant_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(variant_json)),
 quantity INTEGER NOT NULL CHECK (quantity > 0),
 unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
 UNIQUE(quote_id, position)
);

CREATE TABLE IF NOT EXISTS zc_manual_payments (
 id TEXT PRIMARY KEY,
 quote_id TEXT NOT NULL REFERENCES zc_quotes(id),
 kind TEXT NOT NULL CHECK (kind IN ('deposit','balance','other')),
 method TEXT NOT NULL DEFAULT 'sinpe' CHECK (method IN ('sinpe','other')),
 amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
 currency TEXT NOT NULL CHECK (length(currency) = 3),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','proof_received','under_review','verified','rejected','refunded')),
 bank_reference TEXT,
 proof_object_key TEXT,
 received_at TEXT,
 verified_at TEXT,
 verified_by TEXT,
 rejection_reason TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zc_manual_payments_quote ON zc_manual_payments(quote_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS zc_manual_payments_verified_reference
 ON zc_manual_payments(method, bank_reference)
 WHERE status = 'verified' AND bank_reference IS NOT NULL AND bank_reference <> '';

CREATE TABLE IF NOT EXISTS zc_order_links (
 quote_id TEXT PRIMARY KEY REFERENCES zc_quotes(id),
 order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
 created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zc_events (
 id TEXT PRIMARY KEY,
 request_id TEXT REFERENCES zc_requests(id),
 quote_id TEXT REFERENCES zc_quotes(id),
 event_type TEXT NOT NULL,
 actor TEXT NOT NULL,
 payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zc_events_request ON zc_events(request_id, created_at);
CREATE INDEX IF NOT EXISTS zc_events_quote ON zc_events(quote_id, created_at);
