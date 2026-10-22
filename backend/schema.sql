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

WITH RECURSIVE product_numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM product_numbers WHERE n < 16),
shirt_colors(shirt) AS (VALUES(1), (2), (3), (4)), shirt_sizes(size) AS (VALUES('S'), ('M'), ('L'), ('XL'), ('XXL'))
INSERT INTO inventory(product_id, shirt, size, stock, low_stock_threshold, updated_at)
SELECT printf('zc-%03d', n), shirt, size, 12, 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM product_numbers CROSS JOIN shirt_colors CROSS JOIN shirt_sizes
WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id = printf('zc-%03d', n) AND i.shirt = shirt_colors.shirt AND i.size = shirt_sizes.size);

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
