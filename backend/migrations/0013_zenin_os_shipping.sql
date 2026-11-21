-- ZENIN CLUB OS: shipping intake and manual Correos de Costa Rica workflow.
-- Additive. Does not create carrier labels or change existing checkout.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS zc_shipping_profiles (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL UNIQUE REFERENCES zc_requests(id),
 recipient_name TEXT,
 recipient_phone TEXT,
 country_code TEXT NOT NULL DEFAULT 'CR',
 province TEXT,
 canton TEXT,
 district TEXT,
 address_line1 TEXT,
 address_line2 TEXT,
 postal_code TEXT,
 delivery_notes TEXT,
 status TEXT NOT NULL DEFAULT 'incomplete'
   CHECK(status IN ('incomplete','complete','confirmed')),
 confirmed_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zc_shipping_profiles_status ON zc_shipping_profiles(status,updated_at);

CREATE TABLE IF NOT EXISTS zc_shipments (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 order_id TEXT REFERENCES orders(id),
 shipping_profile_id TEXT NOT NULL REFERENCES zc_shipping_profiles(id),
 carrier TEXT NOT NULL DEFAULT 'correos_cr',
 status TEXT NOT NULL DEFAULT 'awaiting_data'
   CHECK(status IN ('awaiting_data','awaiting_payment','ready_to_prepare','prepared','label_created','handed_over','in_transit','delivered','exception','cancelled')),
 tracking_number TEXT,
 tracking_url TEXT,
 label_object_key TEXT,
 prepared_payload_json TEXT CHECK(prepared_payload_json IS NULL OR json_valid(prepared_payload_json)),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK (status NOT IN ('label_created','handed_over','in_transit','delivered') OR tracking_number IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS zc_shipments_tracking
 ON zc_shipments(carrier,tracking_number)
 WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS zc_shipments_queue ON zc_shipments(status,updated_at);

CREATE TABLE IF NOT EXISTS zc_message_tasks (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 shipment_id TEXT REFERENCES zc_shipments(id),
 channel TEXT NOT NULL DEFAULT 'whatsapp'
   CHECK(channel IN ('whatsapp','instagram','facebook','other')),
 purpose TEXT NOT NULL
   CHECK(purpose IN ('missing_order_details','quote_ready','deposit_reminder','shipping_details','balance_reminder','tracking_update','delivery_followup')),
 status TEXT NOT NULL DEFAULT 'draft'
   CHECK(status IN ('draft','needs_review','approved','sent','cancelled')),
 message_text TEXT NOT NULL,
 due_at TEXT,
 approved_by TEXT,
 sent_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS zc_message_tasks_queue ON zc_message_tasks(status,due_at,created_at);

-- Sending messages and purchasing labels are separate operations requiring
-- approved Meta integration and an authorized Correos workflow respectively.
