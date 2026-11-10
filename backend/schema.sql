PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  idempotency_hash TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  tracking_hash TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'preparing', 'ready', 'shipped', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  order_json TEXT NOT NULL CHECK (json_valid(order_json))
);

CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);

-- Inventory bootstrap (kept in sync with migrations/0002_inventory.sql).
-- Additive, rerunnable migration. Seed 12 mock units per catalog variant.
CREATE TABLE IF NOT EXISTS inventory (
  product_id TEXT NOT NULL,
  shirt INTEGER NOT NULL CHECK (shirt BETWEEN 1 AND 4),
  size TEXT NOT NULL CHECK (size IN ('S', 'M', 'L', 'XL', 'XXL')),
  stock INTEGER NOT NULL CHECK (typeof(stock) = 'integer' AND stock >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 3 CHECK (typeof(low_stock_threshold) = 'integer' AND low_stock_threshold BETWEEN 0 AND 999999),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  last_kind TEXT NOT NULL DEFAULT 'seed',
  last_reason TEXT NOT NULL DEFAULT 'mock_initial_stock',
  last_actor TEXT NOT NULL DEFAULT 'system',
  last_order_id TEXT,
  PRIMARY KEY (product_id, shirt, size)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  shirt INTEGER NOT NULL,
  size TEXT NOT NULL,
  delta INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  threshold_after INTEGER NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('seed', 'legacy_topup', 'reserve', 'release', 'adjustment')),
  reason TEXT NOT NULL,
  order_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_id, shirt, size) REFERENCES inventory(product_id, shirt, size)
);
CREATE INDEX IF NOT EXISTS inventory_movements_variant ON inventory_movements(product_id, shirt, size, id DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_order ON inventory_movements(order_id, id DESC);

CREATE TABLE IF NOT EXISTS reservations (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  shirt INTEGER NOT NULL,
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  source TEXT NOT NULL DEFAULT 'checkout' CHECK (source IN ('checkout', 'legacy')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (order_id, product_id, shirt, size),
  FOREIGN KEY (product_id, shirt, size) REFERENCES inventory(product_id, shirt, size)
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS inventory_seed_audit AFTER INSERT ON inventory
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    'seed', 'mock_initial_stock', 'system', NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS inventory_update_audit AFTER UPDATE OF stock, low_stock_threshold ON inventory
WHEN NEW.stock != OLD.stock OR NEW.low_stock_threshold != OLD.low_stock_threshold
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, order_id, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock - OLD.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    NEW.last_kind, NEW.last_reason, NEW.last_order_id, NEW.last_actor, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS reservations_insert_guard BEFORE INSERT ON reservations
BEGIN
  -- Existing orders predate stock accounting. Honor them without negative stock;
  -- every necessary opening-balance top-up is recorded, never silently discarded.
  UPDATE inventory SET stock = NEW.quantity, version = version + 1, updated_at = NEW.updated_at,
    last_kind = 'legacy_topup', last_reason = 'legacy_order_reconciliation', last_actor = 'system', last_order_id = NEW.order_id
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size
    AND NEW.source = 'legacy' AND NEW.active = 1 AND stock < NEW.quantity;
  SELECT CASE WHEN NEW.active = 1 AND COALESCE((SELECT stock FROM inventory
    WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size), -1) < NEW.quantity
    THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_insert_stock AFTER INSERT ON reservations WHEN NEW.active = 1
BEGIN
  UPDATE inventory SET stock = stock - NEW.quantity, version = version + 1, updated_at = NEW.updated_at,
    last_kind = 'reserve', last_reason = 'order_created', last_actor = 'system', last_order_id = NEW.order_id
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
END;

CREATE TRIGGER IF NOT EXISTS reservations_immutable BEFORE UPDATE OF order_id, product_id, shirt, size, quantity, source ON reservations
WHEN NEW.order_id != OLD.order_id OR NEW.product_id != OLD.product_id OR NEW.shirt != OLD.shirt OR
  NEW.size != OLD.size OR NEW.quantity != OLD.quantity OR NEW.source != OLD.source
BEGIN
  SELECT RAISE(ABORT, 'RESERVATION_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS reservations_reopen_guard BEFORE UPDATE OF active ON reservations
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
  SELECT CASE WHEN COALESCE((SELECT stock FROM inventory
    WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size), -1) < NEW.quantity
    THEN RAISE(ABORT, 'INSUFFICIENT_STOCK') END;
END;

CREATE TRIGGER IF NOT EXISTS reservations_reopen_stock AFTER UPDATE OF active ON reservations
WHEN OLD.active = 0 AND NEW.active = 1
BEGIN
  UPDATE inventory SET stock = stock - NEW.quantity, version = version + 1, updated_at = NEW.updated_at,
    last_kind = 'reserve', last_reason = 'order_reopened', last_actor = 'system', last_order_id = NEW.order_id
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
END;

CREATE TRIGGER IF NOT EXISTS reservations_release_stock AFTER UPDATE OF active ON reservations
WHEN OLD.active = 1 AND NEW.active = 0
BEGIN
  UPDATE inventory SET stock = stock + NEW.quantity, version = version + 1, updated_at = NEW.updated_at,
    last_kind = 'release', last_reason = 'order_cancelled', last_actor = 'system', last_order_id = NEW.order_id
  WHERE product_id = NEW.product_id AND shirt = NEW.shirt AND size = NEW.size;
END;

CREATE TRIGGER IF NOT EXISTS reservations_delete_stock AFTER DELETE ON reservations WHEN OLD.active = 1
BEGIN
  UPDATE inventory SET stock = stock + OLD.quantity, version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_kind = 'release', last_reason = 'order_removed',
    last_actor = 'system', last_order_id = OLD.order_id
  WHERE product_id = OLD.product_id AND shirt = OLD.shirt AND size = OLD.size;
END;

-- These triggers make stock updates part of the same order INSERT/UPDATE.
-- RAISE(ABORT) unwinds every line, movement and order change on insufficiency.
CREATE TRIGGER IF NOT EXISTS orders_reserve_inventory AFTER INSERT ON orders
BEGIN
  INSERT INTO reservations(order_id, product_id, shirt, size, quantity, active, source, created_at, updated_at)
  SELECT NEW.id, json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'),
    json_extract(j.value, '$.size'), SUM(json_extract(j.value, '$.quantity')),
    CASE WHEN NEW.status = 'cancelled' THEN 0 ELSE 1 END, 'checkout', NEW.created_at, NEW.updated_at
  FROM json_each(NEW.order_json, '$.items') j
  GROUP BY json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'), json_extract(j.value, '$.size');
END;

CREATE TRIGGER IF NOT EXISTS orders_update_inventory AFTER UPDATE OF status ON orders WHEN OLD.status != NEW.status
BEGIN
  UPDATE reservations SET active = CASE WHEN NEW.status = 'cancelled' THEN 0 ELSE 1 END, updated_at = NEW.updated_at
  WHERE order_id = NEW.id;
END;

-- One row per legacy order/variant is the durable migration marker. Cancelled
-- orders are marked inactive so a later reopen must pass the normal stock guard.
INSERT INTO reservations(order_id, product_id, shirt, size, quantity, active, source, created_at, updated_at)
SELECT o.id, json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'),
  json_extract(j.value, '$.size'), SUM(json_extract(j.value, '$.quantity')),
  CASE WHEN o.status = 'cancelled' THEN 0 ELSE 1 END, 'legacy', o.created_at, o.updated_at
FROM orders o JOIN json_each(o.order_json, '$.items') j
WHERE NOT EXISTS (SELECT 1 FROM reservations r WHERE r.order_id = o.id
  AND r.product_id = json_extract(j.value, '$.productId') AND r.shirt = json_extract(j.value, '$.shirt')
  AND r.size = json_extract(j.value, '$.size'))
GROUP BY o.id, json_extract(j.value, '$.productId'), json_extract(j.value, '$.shirt'), json_extract(j.value, '$.size');

-- Soft stock bootstrap (kept in sync with migrations/0003_soft_stock.sql).
-- Stock is informational: accept every valid order, allocate only availability.
CREATE TABLE IF NOT EXISTS reservation_allocations (
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  shirt INTEGER NOT NULL,
  size TEXT NOT NULL,
  allocated_qty INTEGER NOT NULL CHECK (typeof(allocated_qty) = 'integer' AND allocated_qty >= 0),
  PRIMARY KEY (order_id, product_id, shirt, size),
  FOREIGN KEY (order_id, product_id, shirt, size)
    REFERENCES reservations(order_id, product_id, shirt, size) ON DELETE CASCADE
) WITHOUT ROWID;

-- Every active reservation from the hard-stock version was fully allocated.
-- Never overwrite an existing allocation: a later soft-stock order may own zero.
INSERT INTO reservation_allocations(order_id, product_id, shirt, size, allocated_qty)
SELECT r.order_id, r.product_id, r.shirt, r.size, CASE WHEN r.active = 1 THEN r.quantity ELSE 0 END
FROM reservations r WHERE NOT EXISTS (SELECT 1 FROM reservation_allocations a
  WHERE a.order_id = r.order_id AND a.product_id = r.product_id AND a.shirt = r.shirt AND a.size = r.size);

DROP TRIGGER IF EXISTS reservations_insert_guard;
DROP TRIGGER IF EXISTS reservations_reopen_guard;
DROP TRIGGER IF EXISTS reservations_insert_stock;
DROP TRIGGER IF EXISTS reservations_reopen_stock;
DROP TRIGGER IF EXISTS reservations_release_stock;
DROP TRIGGER IF EXISTS reservations_delete_stock;
DROP TRIGGER IF EXISTS inventory_update_audit;

CREATE TRIGGER inventory_update_audit AFTER UPDATE OF stock, low_stock_threshold, version ON inventory
WHEN NEW.stock != OLD.stock OR NEW.low_stock_threshold != OLD.low_stock_threshold OR NEW.version != OLD.version
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, order_id, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock - OLD.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    NEW.last_kind, NEW.last_reason, NEW.last_order_id, NEW.last_actor, NEW.updated_at);
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

-- Restore before the reservation's cascading delete removes its allocation row.
CREATE TRIGGER reservations_delete_stock BEFORE DELETE ON reservations WHEN OLD.active = 1
BEGIN
  UPDATE inventory SET stock = stock + (SELECT allocated_qty FROM reservation_allocations
      WHERE order_id = OLD.order_id AND product_id = OLD.product_id AND shirt = OLD.shirt AND size = OLD.size),
    version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_kind = 'release',
    last_reason = 'order_removed', last_actor = 'system', last_order_id = OLD.order_id
  WHERE product_id = OLD.product_id AND shirt = OLD.shirt AND size = OLD.size;
END;

-- Shared catalog bootstrap (kept in sync with migrations/0004_products.sql).
-- Persistent catalog. Existing seed IDs and snapshots remain unchanged.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  creation_key_hash TEXT UNIQUE,
  creation_request_hash TEXT,
  product_json TEXT NOT NULL CHECK (json_valid(product_json))
);
CREATE INDEX IF NOT EXISTS products_active ON products(active, created_at, id);

















-- Check current visibility in the same transaction as checkout, including an
-- archive that committed after the Worker read the catalog. Existing order
-- snapshots and idempotent recovery do not insert again and remain unaffected.
CREATE TRIGGER IF NOT EXISTS orders_active_product_guard BEFORE INSERT ON orders
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.order_json, '$.items') j
    LEFT JOIN products p ON p.id = json_extract(j.value, '$.productId')
    WHERE p.id IS NULL OR p.active != 1) THEN RAISE(ABORT, 'INVALID_PRODUCT') END;
END;

-- Product inventory audit: custom opening counts retain the administrator.
DROP TRIGGER IF EXISTS inventory_seed_audit;
CREATE TRIGGER inventory_seed_audit AFTER INSERT ON inventory
BEGIN
  INSERT INTO inventory_movements(product_id, shirt, size, delta, stock_after, threshold_after, version, kind, reason, order_id, actor, created_at)
  VALUES(NEW.product_id, NEW.shirt, NEW.size, NEW.stock, NEW.stock, NEW.low_stock_threshold, NEW.version,
    'seed', NEW.last_reason, NEW.last_order_id, NEW.last_actor, NEW.updated_at);
END;

-- Product design uploads and offered colors (migrations/0005_product_designs.sql).
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

-- Archive conceptual catalog (migrations/0006_archive_demo_catalog.sql).
-- Remove the conceptual emoji catalog without deleting products or history.
-- New installations have no demo seed; existing records remain archived.
UPDATE products SET active = 0, version = version + 1,
 deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE active = 1 AND COALESCE(json_extract(product_json,'$.designUrl'),'') = ''
 AND COALESCE(json_extract(product_json,'$.kind'),'apparel') != 'article';

-- Reusable garment bases (migrations/0007_garment_bases.sql).
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

-- Collections and articles (migrations/0008_collections_articles.sql).
CREATE TABLE IF NOT EXISTS collections (
 id TEXT PRIMARY KEY,
 slug TEXT NOT NULL UNIQUE,
 active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,
 sort_order INTEGER NOT NULL DEFAULT 0,
 collection_json TEXT NOT NULL CHECK (json_valid(collection_json)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 creation_key_hash TEXT UNIQUE, creation_request_hash TEXT
);
CREATE INDEX IF NOT EXISTS collections_active ON collections(active, sort_order, created_at);

CREATE TRIGGER IF NOT EXISTS collection_archive_guard BEFORE UPDATE OF active ON collections
WHEN NEW.active = 0 AND OLD.active = 1
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM products p
  WHERE p.active = 1 AND json_extract(p.product_json,'$.collectionId') = NEW.id)
 THEN RAISE(ABORT,'COLLECTION_IN_USE') END;
END;

-- Article bases (hidden variant sets of bottles, keychains…) change sizes from
-- the article editor together with their single product.
DROP TRIGGER IF EXISTS garment_base_size_guard;
CREATE TRIGGER garment_base_size_guard BEFORE UPDATE OF base_json ON garment_bases
WHEN json_extract(NEW.base_json,'$.sizes') != json_extract(OLD.base_json,'$.sizes')
 AND COALESCE(json_extract(NEW.base_json,'$.kind'),'garment') != 'article'
BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM products p, json_each(p.product_json,'$.shirtOptions') o
  WHERE p.active = 1 AND json_extract(o.value,'$.baseId') = NEW.id)
 THEN RAISE(ABORT,'BASE_SIZE_IN_USE') END;
END;

-- Videos and site settings (migrations/0010_media.sql).
CREATE TABLE IF NOT EXISTS video_assets (
 id TEXT PRIMARY KEY CHECK (length(id) = 64),
 object_key TEXT NOT NULL UNIQUE,
 content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
 byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 52428800),
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_settings (
 key TEXT PRIMARY KEY,
 version INTEGER NOT NULL DEFAULT 1,
 value_json TEXT NOT NULL CHECK (json_valid(value_json)),
 updated_at TEXT NOT NULL
);

-- Payments (migrations/0011_payments.sql).
CREATE TABLE IF NOT EXISTS payment_attempts (
 order_number TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 amount TEXT NOT NULL,
 currency TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('created', 'approved', 'rejected', 'review', 'error', 'expired', 'refunded')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json))
);
CREATE INDEX IF NOT EXISTS payment_attempts_order ON payment_attempts(order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_status ON payment_attempts(status, created_at);
