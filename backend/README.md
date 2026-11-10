# Zenin Club commerce API

Cloudflare Worker with D1 (`DB`) for bases, products, inventory and orders, and R2 (`DESIGNS`) for uploaded PNGs. Checkout records an order without charging a payment; payment processing and transactional email remain separate work.

## Configuration and deployment

`backend/wrangler.toml` binds the D1 database and the dedicated `zenin-club-designs` R2 bucket. Store `ADMIN_PASSWORD_SALT`, `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` through interactive Wrangler secret prompts. The hash is SHA-256 of `salt:password`; the salt needs at least 16 characters and the session secret at least 32. Set `ADMIN_USERNAME` as a Worker variable. Admin bearer sessions expire after six hours.

For a fresh database, apply `backend/schema.sql`. It creates **no sample products, base garments or invented opening inventory**. Existing databases that already have migrations 0002–0004 must apply 0005–0007 in order:

```sh
npx wrangler d1 execute zenin-club-orders --remote --command="PRAGMA foreign_key_check; SELECT COUNT(*) AS orders FROM orders; SELECT COUNT(*) AS variants FROM inventory;" --config=backend/wrangler.toml
npx wrangler d1 execute zenin-club-orders --remote --file=backend/migrations/0005_product_designs.sql --config=backend/wrangler.toml
npx wrangler d1 execute zenin-club-orders --remote --file=backend/migrations/0006_archive_demo_catalog.sql --config=backend/wrangler.toml
npx wrangler d1 execute zenin-club-orders --remote --file=backend/migrations/0007_garment_bases.sql --config=backend/wrangler.toml
npx wrangler d1 execute zenin-club-orders --remote --command="PRAGMA foreign_key_check;" --config=backend/wrangler.toml
npx wrangler deploy --config=backend/wrangler.toml
```

Run each SQL file as a whole transaction. Wrangler 4.151.3 uses D1's atomic import for remote `--file`; local execution uses `DB.batch()`. Do not execute the statements in 0007 separately. It defers foreign keys, copies and rebuilds only inventory, then restores its triggers while retaining orders, reservations, allocations and audit rows. There are no `BEGIN`/`COMMIT` statements in D1 files because D1 owns the transaction. A verified migration runner can also apply these files atomically after its existing migration history has been baselined. Keep a private D1 export or Time Travel bookmark before production changes.

Migration 0006 reversibly archives conceptual products without a PNG. It never deletes products, inventory or historical order snapshots. Migrations 0005–0007 are rerunnable. Older migration files remain historical and must not be used to seed a new store.

## API

All `/admin/*` endpoints except login require `Authorization: Bearer <token>`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | D1 connectivity |
| GET | `/products` | Active product catalog, resolving current base metadata |
| GET | `/bases` | Active shirt types and colors |
| GET | `/collections` | Active collections (slug, names, descriptions, cover, accent) |
| GET | `/inventory` | Public product/color/size stock |
| GET, HEAD | `/designs/:sha256.png` | Immutable public PNG |
| POST | `/orders` | `{order, trackingToken}`, 201 or 200 for an identical retry |
| POST | `/orders/track` | Private order lookup with `{id, token}` or `{id, email}` |
| POST | `/admin/login` | `{token, expiresAt}` |
| POST | `/admin/designs` | Authenticated raw `image/png` upload |
| GET, POST | `/admin/bases` | `{bases}` (`?kind=garment\|article\|all`) / create `{base}` |
| PATCH, DELETE | `/admin/bases/:id` | Versioned update or restore (`active: true`) / archive |
| GET, POST | `/admin/collections` | `{collections}` with `productCount` / create `{collection}` |
| PATCH, DELETE | `/admin/collections/:id` | Versioned update or restore / archive (`COLLECTION_IN_USE` while it has active products) |
| GET, HEAD | `/videos/:sha256.(mp4\|webm)` | Immutable public video with byte-range (206) support |
| GET | `/settings/landing` | Public landing slides |
| POST | `/admin/videos` | Authenticated raw `video/mp4`, `video/quicktime` or `video/webm` upload, up to 50 MiB |
| GET, PUT | `/admin/settings/landing` | Landing slides with `version` / versioned replace (`SETTINGS_CHANGED` on a stale version) |
| GET | `/payments/config` | `{enabled, provider}` |
| GET, PUT | `/admin/settings/payments` | Masked settings `{enabled, apiUser, hasPassword, keyHint, verifiedAt, version}` / versioned save; credentials are verified with Tilopay before enabling |
| POST | `/admin/settings/payments/test` | Tests credentials (`PAYMENT_CREDENTIALS_INVALID`, `PAYMENT_KEY_INVALID`) |
| GET | `/payments/tilopay/return` | Tilopay redirect target: confirms with `consult`, then 303 to the order tracking page |
| POST | `/orders/pay` | `{id, token}` → new Tilopay attempt `{payment: {url}}` for pending or declined orders |
| POST | `/admin/orders/:id/refund` | `{expectedVersion}` full refund through `processModification`, cancels the order |
| POST | `/admin/articles` | Create an article with its variants `{product}` |
| PATCH | `/admin/articles/:id` | Versioned article and variant update |
| GET, POST | `/admin/products` | `{products}` / create `{product}` |
| PATCH, DELETE | `/admin/products/:id` | Versioned update / archive |
| GET | `/admin/inventory` | Variants, summaries and recent audit movements |
| GET, PATCH | `/admin/inventory/:productId/:shirt/:size` | Variant audit / versioned stock update |
| GET | `/admin/orders` | Pagination, status and search filters |
| GET, PATCH | `/admin/orders/:id` | Order details / versioned status, notes or tracking update |

Admin bases/products/inventory accept `?includeArchived=true` when applicable. Removed products and base garments retain their database rows. Order states are `new`, `preparing`, `ready`, `shipped`, `cancelled`; these describe fulfillment, not payment.

## Collections, prices per shirt type, print sides and articles (migration 0008)

Collections have `name`, optional `nameEs`, descriptions, a required uploaded `coverUrl`, an `accent` hex and `sortOrder`. The slug derives from the Spanish name. Products reference `collectionId`; the API resolves `category` (the slug) and current collection names on every read.

Bases accept an optional `printArea` `{x,y,w,h}` in percent of the photo and an optional `backImageUrl` per color. Products accept `printSides` (`front`, `back`, `both`) with `frontDesignUrl`/`backDesignUrl`; `designUrl` remains the primary artwork for older clients. Back prints require a back photo for every selected color (`BACK_PHOTO_REQUIRED`). `basePrices` maps base IDs to prices; every offered option carries its `price`, the product `price` is the lowest, and checkout charges the option price.

Articles (`kind: "article"`) own a hidden article base whose colors are their photographed variants, so stock, checkout, snapshots and guards are shared with shirts. Create and edit them through `/admin/articles`; archive and restore them through `/admin/products/:id`. Migration 0008 is additive and rerunnable; 0009 optionally archives the current catalog without deleting anything.

## Videos and landing (migration 0010)

`POST /admin/videos` requires `Content-Length` (at most 50 MiB), checks the MP4 `ftyp` or WebM EBML signature and stores the bytes content-addressed under `videos/` in the `DESIGNS` bucket. Responses: `{videoId, videoUrl, contentType, byteLength}`. Videos are served with `Accept-Ranges` and 206 partial responses so Safari and iOS can stream them. Collections accept `videos: [{url, posterUrl}]` (up to six). The landing stores up to six slides `{videoUrl, posterUrl, title, titleEn, subtitle, subtitleEn, buttonLabel, buttonLabelEn, link}`; links are store hashes such as `#shop/<slug>` or `https://` addresses.

## Payments (migration 0011)

When payments are enabled (Admin → Pagos, or the optional `TILOPAY_*` Worker secrets), `POST /orders` requires `customer.phone`, accepts `returnUrl` (an allowed storefront origin), stores `order.payment = {provider: "tilopay", status: "pending"}` and returns `payment.url`. Payment statuses: `pending`, `paid`, `failed`, `review` (approved amount differs from the order total), `expired`, `refunded`. Attempts live in `payment_attempts` with their own `orderNumber`. The Worker's `scheduled` handler (cron in `wrangler.toml`) confirms open attempts and expires unpaid orders after 60 minutes. Tilopay's `OrderHash` algorithm and the `processPayment` webhook spec are only available from Tilopay support; this integration does not depend on them.

## PNG uploads

Send the PNG bytes directly to `POST /admin/designs` with `Content-Type: image/png`. The API verifies the signature, IHDR settings, chunk bounds and CRCs, complete IDAT/IEND structure, a maximum file size of 5 MiB, maximum dimension of 8192 and maximum pixel count of 16 × 1024 × 1024. Body limits apply to streamed requests too. Invalid files never reach R2. The endpoint limits uploads to 400 per 15 minutes per IP, enough for a full launch session.

Response:

```json
{"designId":"<sha256>","designUrl":"https://<api>/designs/<sha256>.png","width":2400,"height":2400,"byteLength":123456}
```

The same authenticated endpoint uploads transparent artwork and base photos. References are restricted to existing uploads on this API origin; arbitrary URLs, other hosts, query strings and credentials are rejected. The stored URL is absolute. Content-addressed object keys make upload retries safe. Public image responses use `image/png`, `nosniff`, ETag and immutable cache headers. Images are retained after product/base archival so order snapshots remain usable.

## Reusable product bases

Create a base with:

```json
{"name":"Heavy cotton tee","type":"T-shirt","weightGsm":280,"sizes":["XS","S","M","L","XL"],"colors":[{"name":"Natural","hex":"#f5efdf","imageUrl":"https://<api>/designs/<sha256>.png"}],"idempotencyKey":"unique-base-create-key"}
```

Each base has `id`, `name`, `type`, `weightGsm`, `sizes`, `colors`, `version`, `active`, timestamps. Weight is an integer 0–2000; zero means unspecified/not applicable. Sizes are 1–20 distinct labels of at most 24 characters, including custom labels such as `Talla única`. Colors are 1–30 entries; each requires a name, six-digit hex and uploaded PNG. The server assigns new globally unique numeric `shirt` IDs starting at 100. IDs 1–4 are retained only for historical data.

POST accepts an optional idempotency key. PATCH and DELETE require the reviewed `version`; stale changes return 409 `BASE_CHANGED`. Existing colors keep their `shirt` ID on PATCH; new colors omit it. Removing a color used by an active product returns `BASE_COLOR_IN_USE`; archiving its base returns `BASE_IN_USE`. Changing the sizes of an in-use base returns `BASE_SIZE_IN_USE`; first archive or move the referencing products. This preserves inventory and prevents purchases of sizes with no variant row. Database guards also protect concurrent edits/creation.

Name, type, weight, color name, hex and image changes are reflected in the current catalog and new orders. Existing order snapshots retain their original base metadata and images.

## Products

New products require an uploaded PNG and at least one color from active bases. No emoji is accepted into the new product model or public catalog. Category defaults to `originals` / `Zenin Originals`.

```json
{"name":"Club graphic","nameEs":"Diseño Club","price":42,"designUrl":"https://<api>/designs/<sha256>.png","shirt":100,"availableShirts":[100,102],"initialStock":0,"lowStockThreshold":3,"idempotencyKey":"unique-product-create-key"}
```

`shirt` is the default color and must belong to `availableShirts`. A design can select colors across several bases. The server derives `shirtOptions`, never trusting client-supplied base descriptions or photos:

```json
{"shirt":100,"baseId":"base-UUID","baseName":"Heavy cotton tee","type":"T-shirt","weightGsm":280,"colorName":"Natural","hex":"#f5efdf","imageUrl":"https://<api>/designs/<sha256>.png","sizes":["XS","S","M","L","XL"]}
```

Only selected colors and their base sizes get inventory rows. Opening stock defaults to zero. Name/price/PNG/options are stored in D1; prices have at most two decimal places, USD 0.01–10000. Product creation is atomic with its variants and idempotent. PATCH/DELETE require `version`. Archive hides the product while keeping order, inventory and audit history. Restoring requires valid current bases. Old removed variants remain for historical references but are not offered in the public catalog.

## Orders and informational inventory

Checkout sends customer contact/delivery details, items `{productId,shirt,size,quantity}`, language, optional discount code and a unique idempotency key. Customer name, valid email, address, city and country are required. Each item permits 1–10 units, with at most 40 input lines and 50 units. The server validates current offered colors/sizes and owns all names, prices, totals and snapshots. Each order item retains the design URL and its selected `shirtOptions` entry, so tracking/admin do not depend on an active catalog product.

Stock is informational: zero displays Low stock and does not block a valid purchase. The order records the full purchased quantity; the transactional allocation reserves only available units, never making stock negative. Cancellation returns exactly those allocated units once. Reopening allocates the available units at that time. Inventory edits require `stock`, `lowStockThreshold`, `version` and optional reason, with stale edits returning `INVENTORY_CHANGED`. Order PATCH accepts `expectedVersion` and returns `ORDER_CHANGED` for a stale review. Concurrency uses D1 transactions and database versions rather than Worker-memory locks.

Current shipping remains USD 8, free from a pre-discount USD 120 subtotal. `ZENIN10` is 10% off; other nonempty codes are rejected. Tax, real shipping labels, payment authorization/capture/refunds, fiscal invoices and transactional emails are not implemented by this API.

JSON bodies require `application/json` and are limited to 32 KiB. Public order reads omit admin notes. Tracking tokens are hashed at rest. CORS permits zeninclub.shop, www.zeninclub.shop, the GitHub Pages origin and local port 5173. Login, checkout, tracking and uploads have durable IP rate limits. Passwords, tokens, customer request bodies and SQL errors must never be logged.

## Validation

`npm run check` verifies JavaScript syntax. `npm test` exercises real Worker handlers against a SQLite-backed D1 adapter and an in-memory R2 adapter. Coverage includes PNG validation/auth/cache, base CRUD/global IDs/custom sizes, archived-base races, product creation and stock behavior, order snapshots, migrations with historical rows and foreign-key checks, idempotency, stale writes, tracking privacy, CORS and limits. Node 22+ is required.
