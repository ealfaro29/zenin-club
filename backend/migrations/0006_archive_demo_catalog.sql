-- Remove the conceptual emoji catalog without deleting products or history.
-- New installations have no demo seed; existing records remain archived.
UPDATE products SET active = 0, version = version + 1,
 deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE active = 1 AND COALESCE(json_extract(product_json,'$.designUrl'),'') = ''
 AND COALESCE(json_extract(product_json,'$.kind'),'apparel') != 'article';
