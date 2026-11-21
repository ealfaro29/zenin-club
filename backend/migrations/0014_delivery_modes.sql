-- Shipping delivery modes for Correos de Costa Rica.
-- Apply after 0013_zenin_os_shipping.sql. Additive and rerunnable.
ALTER TABLE zc_shipping_profiles ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'home'
 CHECK (delivery_mode IN ('home','branch'));
ALTER TABLE zc_shipping_profiles ADD COLUMN branch_name TEXT;
ALTER TABLE zc_shipping_profiles ADD COLUMN branch_code TEXT;
-- The default is for existing records only; require explicit mode selection in new intake UI.
CREATE INDEX IF NOT EXISTS zc_shipping_profiles_mode_status
 ON zc_shipping_profiles(delivery_mode,status,updated_at);
