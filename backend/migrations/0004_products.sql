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
