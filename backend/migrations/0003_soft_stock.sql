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
