-- Collections with cover art, per-type prices, front/back prints and articles.
-- Additive and rerunnable. Products keep their JSON; new fields are optional.
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
