-- Immutable PNGs live in the DESIGNS R2 binding. Metadata restricts catalog
-- references to images uploaded through the authenticated store API.
CREATE TABLE IF NOT EXISTS design_assets (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  object_key TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 5242880),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  CHECK (width * height <= 16777216)
);

-- Legacy emoji products omit availableShirts and continue to offer all colors.
-- Check the latest catalog within the order transaction, closing the race with
-- an administrator removing a color after the Worker read the product.
CREATE TRIGGER IF NOT EXISTS orders_offered_color_guard BEFORE INSERT ON orders
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.order_json, '$.items') j
    JOIN products p ON p.id = json_extract(j.value, '$.productId')
    WHERE json_extract(j.value, '$.shirt') NOT IN
      (SELECT value FROM json_each(COALESCE(json_extract(p.product_json, '$.availableShirts'), '[1,2,3,4]')))
  ) THEN RAISE(ABORT, 'INVALID_COLOR') END;
END;

-- Color edits retain previous variant rows and their order/audit references.
-- Newly enabled colors start at zero; informational stock never blocks a sale.
CREATE TRIGGER IF NOT EXISTS products_enable_color_inventory AFTER UPDATE OF product_json ON products
BEGIN
  INSERT OR IGNORE INTO inventory(product_id, shirt, size, stock, low_stock_threshold, updated_at, last_reason, last_actor)
  SELECT NEW.id, c.value, s.size, 0, 3, NEW.updated_at, 'product_color_enabled', 'system'
  FROM json_each(COALESCE(json_extract(NEW.product_json, '$.availableShirts'), '[1,2,3,4]')) c
  CROSS JOIN (SELECT 'S' AS size UNION ALL SELECT 'M' UNION ALL SELECT 'L' UNION ALL SELECT 'XL' UNION ALL SELECT 'XXL') s;
END;
