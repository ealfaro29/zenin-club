-- Enforce one follow-up per sales request. Apply after 0015.
-- Existing stage-2 records are cancelled, not deleted, to preserve audit history.
UPDATE zc_lead_followups
SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE stage = 2 AND status IN ('scheduled','needs_review','approved');
CREATE UNIQUE INDEX IF NOT EXISTS zc_lead_followups_one_per_request
ON zc_lead_followups(request_id)
WHERE stage = 1;
-- No stage 2 can be newly inserted or scheduled, even by older application code.
CREATE TRIGGER IF NOT EXISTS zc_lead_followups_no_second_insert
BEFORE INSERT ON zc_lead_followups WHEN NEW.stage <> 1
BEGIN SELECT RAISE(ABORT, 'ONLY_ONE_FOLLOWUP_ALLOWED'); END;
CREATE TRIGGER IF NOT EXISTS zc_lead_followups_no_second_reactivate
BEFORE UPDATE OF status,stage ON zc_lead_followups
WHEN NEW.stage <> 1 AND NEW.status NOT IN ('cancelled','skipped','sent')
BEGIN SELECT RAISE(ABORT, 'ONLY_ONE_FOLLOWUP_ALLOWED'); END;
