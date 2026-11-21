-- Delivery options offered to Costa Rica social-channel customers.
-- Apply after 0013_zenin_os_shipping.sql, before deploying the intake UI.
-- This migration has not been applied in production.
ALTER TABLE zc_shipping_profiles ADD COLUMN delivery_mode TEXT
 CHECK (delivery_mode IN ('workshop_pickup','home_delivery'));
-- NULL means the customer has not selected a modality.
-- Workshop pickup: Santa Bárbara de Heredia, no delivery fee.
-- Home delivery: quote the configured fee, currently CRC 2500 for eligible orders.
-- Do not assume the same fee applies internationally or to every destination.
CREATE INDEX IF NOT EXISTS zc_shipping_profiles_mode_status
 ON zc_shipping_profiles(delivery_mode,status,updated_at);
