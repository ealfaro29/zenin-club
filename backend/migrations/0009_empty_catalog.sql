-- Optional one-time reset before the launch wizard: hide every current product,
-- garment base and collection. Nothing is deleted; orders, snapshots, images and
-- inventory history remain, and any row can be restored later from the admin.
UPDATE products SET active = 0, version = version + 1,
 deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE active = 1;
UPDATE garment_bases SET active = 0, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE active = 1;
UPDATE collections SET active = 0, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE active = 1;
