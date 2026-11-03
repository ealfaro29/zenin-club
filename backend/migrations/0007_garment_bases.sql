-- Rebuild only inventory to permit reusable base colors and custom sizes.
-- Run this migration as one D1 transaction; deferred references retain every
-- existing reservation, allocation and movement while the table is replaced.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE IF NOT EXISTS garment_bases (
 id TEXT PRIMARY KEY,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,
 base_json TEXT NOT NULL CHECK (json_valid(base_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 creation_key_hash TEXT UNIQUE, creation_request_hash TEXT, mutation_key TEXT
);
CREATE TABLE IF NOT EXISTS garment_colors (
 shirt INTEGER PRIMARY KEY CHECK (shirt > 0),
 base_id TEXT NOT NULL REFERENCES garment_bases(id),
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 color_json TEXT NOT NULL CHECK (json_valid(color_json))
);
CREATE INDEX IF NOT EXISTS garment_colors_base ON garment_colors(base_id, active, shirt);
DROP TRIGGER IF EXISTS inventory_seed_audit;
DROP TRIGGER IF EXISTS inventory_update_audit;
DROP TRIGGER IF EXISTS orders_reserve_inventory;
DROP TRIGGER IF EXISTS orders_update_inventory;
DROP TRIGGER IF EXISTS products_enable_color_inventory;
DROP TRIGGER IF EXISTS reservations_delete_stock;
DROP TRIGGER IF EXISTS reservations_insert_stock;
DROP TRIGGER IF EXISTS reservations_release_stock;
DROP TRIGGER IF EXISTS reservations_reopen_stock;
CREATE TABLE inventory_dynamic (
 product_id TEXT NOT NULL,
 shirt INTEGER NOT NULL CHECK (shirt > 0),
 size TEXT NOT NULL CHECK (length(size) BETWEEN 1 AND 24),
 stock INTEGER NOT NULL CHECK (typeof(stock) = 'integer' AND stock >= 0),
 low_stock_threshold INTEGER NOT NULL DEFAULT 3 CHECK (typeof(low_stock_threshold) = 'integer' AND low_stock_threshold BETWEEN 0 AND 999999),
 version INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL,
 last_kind TEXT NOT NULL DEFAULT 'seed', last_reason TEXT NOT NULL DEFAULT 'opening_stock',
 last_actor TEXT NOT NULL DEFAULT 'system', last_order_id TEXT,
 PRIMARY KEY (product_id,shirt,size)
) WITHOUT ROWID;
CREATE TABLE inventory_migration_rows AS SELECT * FROM inventory;
DROP TABLE inventory;
ALTER TABLE inventory_dynamic RENAME TO inventory;
INSERT INTO inventory SELECT * FROM inventory_migration_rows;
DROP TABLE inventory_migration_rows;
CREATE TRIGGER inventory_seed_audit AFTER INSERT ON inventory
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, order_id, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    'seed', NEW.last_reason, NEW.last_order_id, NEW.last_actor, NEW.updated_at);
END;
CREATE TRIGGER inventory_update_audit AFTER UPDATE OF stock, low_stock_threshold, version ON inventory
WHEN NEW.stock != OLD.stock OR NEW.low_stock_threshold != OLD.low_stock_threshold OR NEW.version != OLD.version
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, order_id, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock - OLD.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    NEW.last_kind, NEW.last_reason, NEW.last_order_id, NEW.last_actor, NEW.updated_at);
END;
CREATE TRIGGER orders_reserve_inventory AFTER INSERT ON orders
BEGIN
  INSERT INTO reservations(order_id, product_id, shirt, size, quantity, active, source, created_at, updated_at)
  SELECT NEW.id, json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'),
    json_extract(j.value, '$.size'), SUM(json_extract(j.value, '$.quantity')),
    CASE WHEN NEW.status = 'cancelled' THEN 0 ELSE 1 END, 'checkout', NEW.created_at, NEW.updated_at
  FROM json_each(NEW.order_json, '$.items') j
  GROUP BY json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'), json_extract(j.value, '$.size');
END;
CREATE TRIGGER orders_update_inventory AFTER UPDATE OF status ON orders WHEN OLD.status != NEW.status
BEGIN
  UPDATE reservations SET active = CASE WHEN NEW.status = 'cancelled' THEN 0 ELSE 1 END, updated_at = NEW.updated_at
  WHERE order_id = NEW.id;
END;
CREATE TRIGGER products_enable_color_inventory AFTER UPDATE OF product_json ON products
WHEN json_type(NEW.product_json, '$.shirtOptions') = 'array'
BEGIN
 INSERT OR IGNORE INTO inventory(product_id,shirt,size,stock,low_stock_threshold,updated_at,last_reason,last_actor)
 SELECT NEW.id, json_extract(c.value,'$.shirt'), s.value, 0, 3, NEW.updated_at, 'product_color_enabled','system'
 FROM json_each(NEW.product_json,'$.shirtOptions') c JOIN json_each(c.value,'$.sizes') s;
END;
CREATE TRIGGER reservations_delete_stock BEFORE DELETE ON reservations WHEN OLD.active = 1
BEGIN
  UPDATE inventory SET stock = stock + (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = OLD.order_id AND product_id = OLD.product_id AND shirt = OLD.shirt AND size = OLD.size),
    version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_kind = 'release',
    last_reason = 'order_removed', last_actor = 'system', last_order_id = OLD.order_id
  WHERE product_id = OLD.product_id AND shirt = OLD.shirt AND size = OLD.size;
END;
CREATE TRIGGER reservations_insert_stock AFTER INSERT ON reservations
BEGIN
  INSERT INTO reservation_allocations(order_id, product_id, shirt, size, allocated_qty)
  VALUES(NEW.order_id, NEW.product_id, NEW.shirt, NEW.size, CASE WHEN NEW.active = 1 THEN
    MIN(NEW.quantity, COALESCE((SELECT stock FROM inventory
      WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size), 0)) ELSE 0 END);
  UPDATE inventory SET stock = stock - (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size),
    version = version + 1, updated_at = NEW.updated_at, last_kind = 'reserve', last_actor = 'system', last_order_id = NEW.order_id,
    last_reason = CASE WHEN (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size) < NEW.quantity
      THEN 'order_backordered' ELSE 'order_created' END
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size AND NEW.active = 1;
END;
CREATE TRIGGER reservations_release_stock AFTER UPDATE OF active ON reservations
WHEN OLD.active = 1 AND NEW.active = 0
BEGIN
  UPDATE inventory SET stock = stock + (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size),
    version = version + 1, updated_at = NEW.updated_at, last_kind = 'release', last_reason = 'order_cancelled',
    last_actor = 'system', last_order_id = NEW.order_id
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
  UPDATE reservation_allocations SET allocated_qty = 0
  WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
END;
CREATE TRIGGER reservations_reopen_stock AFTER UPDATE OF active ON reservations
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
  UPDATE reservation_allocations SET allocated_qty = MIN(NEW.quantity, COALESCE((SELECT stock FROM inventory
      WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size), 0))
  WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
  UPDATE inventory SET stock = stock - (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size),
    version = version + 1, updated_at = NEW.updated_at, last_kind = 'reserve', last_actor = 'system', last_order_id = NEW.order_id,
    last_reason = CASE WHEN (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = NEW.order_id AND product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size) < NEW.quantity
      THEN 'order_backordered' ELSE 'order_reopened' END
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
END;
CREATE TRIGGER IF NOT EXISTS garment_base_archive_guard BEFORE UPDATE OF active ON garment_bases
WHEN NEW.active = 0 AND OLD.active = 1
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM products p, json_each(p.product_json,'$.shirtOptions') o
  WHERE p.active = 1 AND json_extract(o.value,'$.baseId') = NEW.id)
 THEN RAISE(ABORT,'BASE_IN_USE') END;
END;
CREATE TRIGGER IF NOT EXISTS garment_color_archive_guard BEFORE UPDATE OF active ON garment_colors
WHEN NEW.active = 0 AND OLD.active = 1
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM products p, json_each(p.product_json,'$.availableShirts') o
  WHERE p.active = 1 AND o.value = NEW.shirt)
 THEN RAISE(ABORT,'BASE_COLOR_IN_USE') END;
END;

CREATE TRIGGER IF NOT EXISTS garment_base_size_guard BEFORE UPDATE OF base_json ON garment_bases
WHEN json_extract(NEW.base_json,'$.sizes') != json_extract(OLD.base_json,'$.sizes')
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM products p, json_each(p.product_json,'$.shirtOptions') o
  WHERE p.active = 1 AND json_extract(o.value,'$.baseId') = NEW.id)
 THEN RAISE(ABORT,'BASE_SIZE_IN_USE') END;
END;
CREATE TRIGGER IF NOT EXISTS products_active_base_insert_guard BEFORE INSERT ON products
WHEN NEW.active = 1 AND COALESCE(json_extract(NEW.product_json,'$.designUrl'),'') != ''
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.product_json,'$.shirtOptions') o
  LEFT JOIN garment_colors c ON c.shirt = json_extract(o.value,'$.shirt')
  LEFT JOIN garment_bases b ON b.id = c.base_id
  WHERE c.shirt IS NULL OR c.active != 1 OR b.active != 1
   OR json_extract(o.value,'$.sizes') != json_extract(b.base_json,'$.sizes'))
 THEN RAISE(ABORT,'INVALID_COLOR') END;
END;
CREATE TRIGGER IF NOT EXISTS products_active_base_update_guard BEFORE UPDATE OF active,product_json ON products
WHEN NEW.active = 1 AND COALESCE(json_extract(NEW.product_json,'$.designUrl'),'') != ''
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.product_json,'$.shirtOptions') o
  LEFT JOIN garment_colors c ON c.shirt = json_extract(o.value,'$.shirt')
  LEFT JOIN garment_bases b ON b.id = c.base_id
  WHERE c.shirt IS NULL OR c.active != 1 OR b.active != 1
   OR json_extract(o.value,'$.sizes') != json_extract(b.base_json,'$.sizes'))
 THEN RAISE(ABORT,'INVALID_COLOR') END;
END;
CREATE TRIGGER IF NOT EXISTS orders_offered_size_guard BEFORE INSERT ON orders
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.order_json,'$.items') j
 JOIN products p ON p.id = json_extract(j.value,'$.productId')
 WHERE json_type(p.product_json,'$.shirtOptions') = 'array'
 AND EXISTS (SELECT 1 FROM json_each(p.product_json,'$.availableShirts') a WHERE a.value = json_extract(j.value,'$.shirt'))
 AND NOT EXISTS (
  SELECT 1 FROM json_each(p.product_json,'$.shirtOptions') o, json_each(o.value,'$.sizes') s
  WHERE json_extract(o.value,'$.shirt') = json_extract(j.value,'$.shirt')
   AND s.value = json_extract(j.value,'$.size')))
 THEN RAISE(ABORT,'INVALID_SIZE') END;
END;
