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

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-001', 'midnight-snack-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-001","slug":"midnight-snack-tee","name":"Midnight Snack Tee","collection":"Food Court","category":"food","emoji":"🍒","shirt":1,"price":42,"colorName":"Washed Black","tag":"CLUB FAVORITE","description":"Sweet trouble, served after dark. A heavyweight everyday tee with a cherry on top.","printLine":"SWEET AFTER DARK","accent":"#df3143"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-001');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-002', 'everything-is-fine-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-002","slug":"everything-is-fine-tee","name":"Everything Is Fine Tee","collection":"Mood Swings","category":"faces","emoji":"🫠","shirt":2,"price":42,"colorName":"Deep Teal","tag":"NEW","description":"Keeping it together is a full-time job. Take a day off in your new favorite tee.","printLine":"HOLDING IT TOGETHER","accent":"#eed94b"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-002');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-003', 'night-shift-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-003","slug":"night-shift-tee","name":"Night Shift Tee","collection":"After Hours","category":"cars","emoji":"🏎️","shirt":3,"price":46,"colorName":"Dusty Violet","tag":"NEW","description":"No finish line. Just the long way home. Built for the hours that belong to you.","printLine":"LAST ONE HOME","accent":"#a9dc72"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-003');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-004', 'lucky-break-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-004","slug":"lucky-break-tee","name":"Lucky Break Tee","collection":"Everyday Objects","category":"objects","emoji":"🎱","shirt":4,"price":44,"colorName":"Faded Red","tag":"CLUB FAVORITE","description":"Good things come to those who take the shot. Your lucky shirt starts here.","printLine":"MAKE YOUR OWN LUCK","accent":"#f5ecce"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-004');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-005', 'by-the-slice-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-005","slug":"by-the-slice-tee","name":"By the Slice Tee","collection":"Food Court","category":"food","emoji":"🍕","shirt":3,"price":40,"colorName":"Dusty Violet","tag":"","description":"A little extra cheese never hurt. For late orders and even later plans.","printLine":"ONE MORE SLICE","accent":"#ef9a3b"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-005');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-006', 'regular-order-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-006","slug":"regular-order-tee","name":"Regular Order Tee","collection":"Food Court","category":"food","emoji":"🍔","shirt":2,"price":40,"colorName":"Deep Teal","tag":"","description":"You know what you like. An everyday staple with all the good stuff stacked in.","printLine":"THE USUAL PLEASE","accent":"#edb34b"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-006');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-007', 'hot-stuff-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-007","slug":"hot-stuff-tee","name":"Hot Stuff Tee","collection":"Food Court","category":"food","emoji":"🌶️","shirt":1,"price":42,"colorName":"Washed Black","tag":"NEW","description":"A little heat goes a long way. Turn the temperature up without saying a word.","printLine":"HANDLE WITH ATTITUDE","accent":"#e94735"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-007');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-008', 'good-enough-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-008","slug":"good-enough-tee","name":"Good Enough Tee","collection":"Mood Swings","category":"faces","emoji":"🙂","shirt":1,"price":38,"colorName":"Washed Black","tag":"","description":"A perfectly average day deserves a very good shirt. Consider the mood handled.","printLine":"DOING MY BEST ISH","accent":"#ead44a"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-008');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-009', 'head-in-orbit-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-009","slug":"head-in-orbit-tee","name":"Head in Orbit Tee","collection":"Mood Swings","category":"faces","emoji":"😵‍💫","shirt":3,"price":44,"colorName":"Dusty Violet","tag":"NEW","description":"Too many tabs open. One less outfit to think about. A uniform for beautiful chaos.","printLine":"CURRENTLY ELSEWHERE","accent":"#c5e77c"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-009');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-010', 'bad-influence-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-010","slug":"bad-influence-tee","name":"Bad Influence Tee","collection":"Mood Swings","category":"faces","emoji":"😈","shirt":4,"price":44,"colorName":"Faded Red","tag":"","description":"The friend your friends warned you about. Great company, questionable ideas.","printLine":"PROBABLY A GOOD IDEA","accent":"#c39df1"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-010');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-011', 'hold-it-together-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-011","slug":"hold-it-together-tee","name":"Hold It Together Tee","collection":"Everyday Objects","category":"objects","emoji":"🧷","shirt":2,"price":40,"colorName":"Deep Teal","tag":"","description":"Small things do the heavy lifting. A quiet classic for your daily rotation.","printLine":"BARELY BUT BEAUTIFULLY","accent":"#d6ded7"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-011');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-012', 'private-club-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-012","slug":"private-club-tee","name":"Private Club Tee","collection":"Everyday Objects","category":"objects","emoji":"🔒","shirt":1,"price":42,"colorName":"Washed Black","tag":"","description":"Keep a little mystery. Membership is a state of mind, and the dress code is easy.","printLine":"IF YOU KNOW YOU KNOW","accent":"#dfbd55"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-012');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-013', 'on-repeat-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-013","slug":"on-repeat-tee","name":"On Repeat Tee","collection":"Everyday Objects","category":"objects","emoji":"📼","shirt":3,"price":44,"colorName":"Dusty Violet","tag":"NEW","description":"Some things are better the second time around. Your next most-played wardrobe track.","printLine":"PLAY IT AGAIN","accent":"#edac69"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-013');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-014', 'joyride-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-014","slug":"joyride-tee","name":"Joyride Tee","collection":"After Hours","category":"cars","emoji":"🚗","shirt":1,"price":46,"colorName":"Washed Black","tag":"CLUB FAVORITE","description":"Windows down. Nowhere in particular. A love letter to taking the scenic route.","printLine":"NO FIXED DESTINATION","accent":"#ed5c4b"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-014');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-015', 'out-of-office-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-015","slug":"out-of-office-tee","name":"Out of Office Tee","collection":"After Hours","category":"cars","emoji":"🚙","shirt":4,"price":46,"colorName":"Faded Red","tag":"","description":"Your automatic reply is already on. Find a road, bring a friend, lose the schedule.","printLine":"BACK WHENEVER","accent":"#8dbad8"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-015');

INSERT INTO products(id, slug, created_at, updated_at, product_json)
SELECT 'zc-016', 'long-weekend-tee', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '{"id":"zc-016","slug":"long-weekend-tee","name":"Long Weekend Tee","collection":"After Hours","category":"cars","emoji":"🚐","shirt":2,"price":48,"colorName":"Deep Teal","tag":"NEW","description":"Pack light. Stay longer. Made for the kind of plans that don''t need a return date.","printLine":"TAKE THE LONG WAY","accent":"#e7c080"}' WHERE NOT EXISTS (SELECT 1 FROM products WHERE id = 'zc-016');

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
