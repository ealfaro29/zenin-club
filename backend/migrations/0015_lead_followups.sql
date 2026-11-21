-- Sales follow-up queue for interested leads. Additive migration.
CREATE TABLE IF NOT EXISTS zc_lead_followups (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES zc_requests(id),
 stage INTEGER NOT NULL CHECK(stage IN (1,2)),
 due_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'scheduled'
   CHECK(status IN ('scheduled','needs_review','approved','sent','cancelled','skipped')),
 last_customer_message_at TEXT,
 last_agent_message_at TEXT,
 customer_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(customer_opt_in IN (0,1)),
 template_name TEXT,
 message_text TEXT NOT NULL,
 sent_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(request_id,stage)
);
CREATE INDEX IF NOT EXISTS zc_lead_followups_due ON zc_lead_followups(status,due_at);
-- Eligibility checks (no purchase, opt-in, customer activity, quiet hours,
-- WhatsApp 24h window and approved template) belong in the service layer.
