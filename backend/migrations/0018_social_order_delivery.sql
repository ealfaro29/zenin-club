-- Reserved migration: delivery status and delivered_at are included in
-- 0017_social_orders.sql before any production deployment.
-- No-op. Do not rebuild a table under D1 migration transaction.
SELECT 1;
