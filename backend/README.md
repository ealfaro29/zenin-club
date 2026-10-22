# Zenin Club order API

An ES-module Cloudflare Worker stores the shared product catalog, inventory and orders in the D1 binding `DB`. Product names and prices come from D1 when an order is created. The original 16 products from `docs/data/products.json` are a migration seed; the Worker does not import or fall back to that static catalog. The API records orders and fulfillment status without collecting or charging a payment.

## Configuration

`backend/wrangler.toml` binds the D1 database as `DB`. Apply `backend/schema.sql` for a fresh database. Existing databases should apply missing migrations in order: `0002_inventory.sql`, `0003_soft_stock.sql`, then `0004_products.sql`. A database already using informational stock only needs `0004_products.sql`. Apply migrations before deploying the matching Worker. Every migration is rerunnable; the full schema includes all three for fresh setups.

From the repository root, after inventory migration `0002` is present:

```sh
npx wrangler d1 execute zenin-club-orders --remote --file=backend/migrations/0003_soft_stock.sql --config=backend/wrangler.toml
npx wrangler d1 execute zenin-club-orders --remote --file=backend/migrations/0004_products.sql --config=backend/wrangler.toml
npx wrangler deploy --config=backend/wrangler.toml
```

Set `ADMIN_USERNAME` to the chosen username in Worker variables. Store these values as Worker secrets, never in checked-in JavaScript or configuration:

- `ADMIN_PASSWORD_SALT`: at least 16 random characters
- `ADMIN_PASSWORD_HASH`: lowercase SHA-256 hex digest of the UTF-8 string `salt:password`
- `ADMIN_SESSION_SECRET`: at least 32 random characters, preferably 32 random bytes encoded as hex or base64

Set secrets using the interactive `wrangler secret put` commands for the configured Worker. Passwords are checked exactly as entered, without trimming or Unicode normalization. Admin bearer sessions expire after six hours. Keep the session secret stable: rotating it invalidates admin sessions and changes the token regenerated for an idempotent checkout retry. Tracking tokens already issued remain valid against the stored hash.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Checks D1 connectivity |
| GET | `/products` | Public, current active product catalog |
| GET | `/inventory` | Public availability for all product/color/size variants |
| POST | `/orders` | Creates an order; returns `{order, trackingToken}` with HTTP 201, or HTTP 200 for a matching retry |
| POST | `/orders/track` | Reads an order using `{id, token}` or `{id, email}` |
| POST | `/admin/login` | Exchanges `{username, password}` for `{token, expiresAt}` |
| GET | `/admin/orders` | Lists orders with optional `status`, `search`, `page`, and `limit` |
| GET | `/admin/orders/:id` | Reads complete admin order details |
| PATCH | `/admin/orders/:id` | Updates `status`, `notes`, or `tracking: {carrier, number}` |
| GET | `/admin/inventory` | All inventory variants, summaries, metadata and their last 10 movements |
| GET | `/admin/inventory/:productId/:shirt/:size` | One variant and its last 50 movements |
| PATCH | `/admin/inventory/:productId/:shirt/:size` | Sets available stock and its low-stock threshold with a required version |
| GET | `/admin/products` | Active products with admin versions; `?includeArchived=true` includes archived ones |
| POST | `/admin/products` | Creates one shared product and all 20 inventory variants atomically |
| PATCH | `/admin/products/:id` | Edits a product or restores it with `active: true`, requiring its reviewed `version` |
| DELETE | `/admin/products/:id` | Archives a product with its reviewed `version`, preserving history |

All admin order, inventory and catalog endpoints require `Authorization: Bearer <token>`. Order status values are `new`, `preparing`, `ready`, `shipped`, and `cancelled`. Status changes append to `history`; repeating the same status does not add another event. Admin order reads/list entries expose `order.version`. Admin clients should send `expectedVersion` with every order PATCH; a stale reviewed version receives HTTP 409 `ORDER_CHANGED` before any change, including stock. This field remains optional temporarily for an already-open older client. The version is not stored in order JSON or included in public tracking responses. Concurrent updates use database version comparisons and `UPDATE ... RETURNING` rows, rather than D1's trigger-inclusive change counts.

## Shared product catalog

`GET /products` returns `{products: [...]}` using the existing product model: `id`, `slug`, `name`, `nameEs`, `category`, `collection`, `price`, `emoji`, `shirt`, `colorName`, `description`, `descriptionEs`, `printLine`, `tag`, and `accent`. Archived products are omitted. An empty array is authoritative; migration reruns and fresh Worker instances never reactivate archived seed products.

Create a product with `POST /admin/products`:

```json
{"name":"Cloud Tee","nameEs":"Camiseta Nube","category":"faces","price":42,"emoji":"☁️","shirt":2,"initialStock":0,"lowStockThreshold":3,"idempotencyKey":"a-client-generated-unique-product-id"}
```

Optional fields are `description`, `descriptionEs`, `printLine`, `tag`, `accent`, and `slug`. Categories are `food`, `faces`, `objects`, and `cars`; collection and displayed color names are derived by the server. IDs are opaque `zc-UUID` values. A missing slug is generated from the name plus a unique suffix. Prices range from USD 0.01 to 10000 with at most two decimal places. Name lengths are 2–120 characters, descriptions allow 2000, print lines allow 120, tags allow 40, and emoji fields allow 32 characters without HTML. Initial stock defaults to 12 and the threshold defaults to 3; both accept integers from 0 to 999999.

Creation returns `{product}` with HTTP 201. Reusing the same optional idempotency key and details returns the same product with HTTP 200, even after archiving; different details with the same key receive `IDEMPOTENCY_CONFLICT`. The product and its 4 colors × 5 sizes are created in one D1 transaction. Replays do not reset later inventory adjustments.

Admin product objects add `active`, `version`, `createdAt`, `updatedAt`, and `deletedAt`. Send `{version, ...changedFields}` to PATCH a product or `{version, active:true}` to restore it. DELETE accepts `{version}` and returns `{id, archived:true, product}`. Repeating a completed archive is idempotent. Stale active-product edits receive `PRODUCT_CHANGED`; unknown products receive `PRODUCT_NOT_FOUND`, and duplicate explicit slugs receive `SLUG_TAKEN`.

Archiving hides the product and its variants from public catalog/inventory and default admin inventory. `?includeArchived=true` exposes archived products or inventory to an administrator, and individual variant history remains accessible. Orders, inventory rows, allocations and movement history remain intact. New orders reject unknown or archived products using both a Worker check and a database guard that closes an archive/checkout race. Idempotent recovery of an earlier successful order still succeeds. Order items retain their original English/Spanish names and price snapshots after catalog edits or archiving.

## Shared inventory

The original inventory contains 16 products × 4 colors × 5 sizes: **320 variants**, seeded with **12 mock units each** and a default low-stock threshold of 3. New products add 20 variants using their entered opening count. `stock` means available units after allocating stock to active orders, floored at zero. Counts at or below the threshold, including zero, display **Low stock**. Stock is informational and never blocks a valid purchase or order reopening.

`GET /inventory` returns `{variants: [{productId, shirt, size, stock}]}` and exposes no admin notes, audit reasons, thresholds, or customer data. `GET /admin/inventory` returns:

```text
{variants: [{productId, shirt, size, stock, lowStockThreshold, version,
            updatedAt, name, emoji, colorName, history}],
 summary: {products, variants, totalStock, outOfStock, lowStock},
 meta: {initialStock: 12, defaultLowStockThreshold: 3, mockSeed: true}}
```

Patch a variant with `{stock, lowStockThreshold, version, reason?}`. Stock and threshold inputs are integers from 0 to 999999; reason is optional and limited to 240 characters. Stock returned after a cancellation can exceed the manual-entry limit because valid reserved units must always be returned. Every edit requires the version that the administrator reviewed. HTTP 409 `INVENTORY_CHANGED` requires a refresh and explicit review; a stale value is never applied automatically. The response is `{variant}` with the updated version and recent history. Threshold-only changes produce an audit movement with `delta: 0`.

Movements contain `{id, productId, shirt, size, delta, stockAfter, lowStockThreshold, version, kind, reason, orderId, at, actor}`. Kinds are `seed`, `legacy_topup`, `reserve`, `release`, and `adjustment`. Admin changes retain the configured username and reason; order changes use the system actor. The single-variant GET returns `{variant, history}`, including up to 50 recent movements.

Creating an order preserves every requested quantity and allocates `min(requested, available)` per variant inside the same D1 transaction. Available stock decreases only by the allocated quantity and stays at zero when nothing is available. A purchase of 5 units with 2 available is accepted with its full quantity of 5 and an allocation of 2; a purchase at zero is also accepted. Input and quantity limits still apply. Idempotent retries return the same order without allocating again.

`reservation_allocations` records the actual allocation separately from the full order quantity. Cancellation returns only the allocation, exactly once, then resets it to zero. An order placed at zero therefore creates no stock when cancelled. Reopening always succeeds and allocates whichever units are available at that time; moving between other active statuses, including shipped, does not allocate again. Later manual restocking does not automatically allocate additional units to existing orders. SQLite triggers keep allocation, movement history and the order change atomic; order creation uses [D1 `batch()` transaction rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). There are no Worker-memory locks.

Migration `0002` preserves order records and creates one durable reservation per legacy order/variant, reconciling active legacy demand with audited opening-balance top-ups where needed. Migration `0003` backfills allocations for existing active reservations, which were fully allocated by the earlier version, and records zero for cancelled ones. It replaces the earlier stock guards with informational stock behavior. Reruns preserve manual counts, existing allocations (including zero), order records and audit history.

Purchases that exceed available stock use audit reason `order_backordered`. An accepted purchase at zero still increments the variant version and records a reservation movement with `delta: 0`; the full purchased quantity remains in the order details. A zero movement describes the change in available stock, not the purchased quantity.

Create body:

```json
{
  "customer": {"name":"Customer Name","email":"customer@example.com","address":"123 Street","apartment":"","city":"San José","postal":"10101","country":"CR"},
  "items": [{"productId":"zc-001","shirt":1,"size":"M","quantity":1}],
  "discountCode": "ZENIN10",
  "language": "es",
  "idempotencyKey": "a-client-generated-unique-checkout-id"
}
```

Use a fresh idempotency key per intended order and reuse it for network retries. Matching keys with different normalized order details receive HTTP 409 `IDEMPOTENCY_CONFLICT`. Duplicate variant lines are merged. Names, emoji, color names and prices are generated from the catalog and selected shirt color; client-supplied prices are ignored.

Sizes are S, M, L, XL and XXL. `shirt` is an integer from 1 to 4. Each variant permits 1–10 units, with at most 40 submitted lines and 50 total units. Name, valid email, address, city and country are required. Apartment and postal code may be empty. Requests require `application/json` and are limited to 32 KB, including streamed requests without a trustworthy Content-Length header. Language defaults to Spanish (`es`), with `en` also supported.

Shipping is USD 8, or free when the **pre-discount** subtotal is at least USD 120. `ZENIN10` deducts 10%; unknown nonempty codes are rejected. Integer cent calculations prevent floating-point price drift. Tax and payment processing are not part of this API.

Public order responses omit internal admin notes. Customer and delivery details are returned only after order creation or successful tracking credentials. Tracking tokens are generated by a domain-separated HMAC over a cryptographically random order UUID and the checkout identifier hash; only a SHA-256 tracking-token hash is stored in D1. Idempotency keys are also stored as hashes. Orders contain customer personal information and should only be accessible to the account owner and authorized administrators.

Errors use `{error: {code, message, field?, retryAfter?}}`. Frontends should translate `code` and `field`, rather than show the brief fallback English message directly. D1-backed fixed-window limits allow 5 login attempts per 15 minutes, 20 order submissions per hour, and 120 tracking attempts per 15 minutes for each Cloudflare client IP. Rate-limit records contain hashed bucket identifiers, not plaintext IPs. The Worker never logs customer details, credentials, request bodies, or database errors.

CORS allows only `https://ealfaro29.github.io`, `http://localhost:5173`, and `http://127.0.0.1:5173`. It never uses `*`, credentialed cookies, or a reflected unapproved origin. Requests without an Origin header remain available to authenticated administrative clients.

## Validation

Run `node --test backend/tests.mjs` with Node 22 or later, including the built-in experimental SQLite module. Tests execute actual Worker handlers, SQL triggers and migrations against a SQLite-backed D1 adapter with transactional batches. Coverage includes order/auth/privacy behavior, stock allocation/cancellation, D1 trigger-count compatibility, optimistic edits, product creation/archiving/restoring, price and emoji validation, idempotent product retries, atomic product/variant creation, preserved Spanish order snapshots, archive/checkout races, and empty catalogs surviving migration reruns and new database connections. These tests do not replace a deployed D1 smoke check.
