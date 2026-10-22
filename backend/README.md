# Zenin Club order API

An ES-module Cloudflare Worker stores orders in the D1 binding `DB`. The catalog in `../docs/data/products.json` is bundled into the Worker so the server owns names and prices. Orders are shared between devices through D1; browser storage is not the source of truth. The API records orders and fulfillment status, without collecting or charging a payment.

## Configuration

`backend/wrangler.toml` binds the D1 database as `DB`. Apply `backend/schema.sql` for a fresh database. For an existing order database, apply the additive `backend/migrations/0002_inventory.sql` before deploying this Worker version. Both SQL files are safe to apply repeatedly; the full schema includes the same inventory migration for fresh setups.

Set `ADMIN_USERNAME` to the chosen username in Worker variables. Store these values as Worker secrets, never in checked-in JavaScript or configuration:

- `ADMIN_PASSWORD_SALT`: at least 16 random characters
- `ADMIN_PASSWORD_HASH`: lowercase SHA-256 hex digest of the UTF-8 string `salt:password`
- `ADMIN_SESSION_SECRET`: at least 32 random characters, preferably 32 random bytes encoded as hex or base64

Set secrets using the interactive `wrangler secret put` commands for the configured Worker. Passwords are checked exactly as entered, without trimming or Unicode normalization. Admin bearer sessions expire after six hours. Keep the session secret stable: rotating it invalidates admin sessions and changes the token regenerated for an idempotent checkout retry. Tracking tokens already issued remain valid against the stored hash.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Checks D1 connectivity |
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

Admin order and inventory endpoints require `Authorization: Bearer <token>`. Order status values are `new`, `preparing`, `ready`, `shipped`, and `cancelled`. Status changes append to `history`; repeating the same status does not add another event. Admin order reads/list entries expose `order.version`. Admin clients should send `expectedVersion` with every order PATCH; a stale reviewed version receives HTTP 409 `ORDER_CHANGED` before any change, including stock. This field remains optional temporarily for an already-open older client. The version is not stored in order JSON or included in public tracking responses. Concurrent updates are additionally guarded by a database version comparison.

## Shared inventory

The inventory contains 16 products × 4 colors × 5 sizes: **320 variants**, initially seeded with **12 mock units each** and a default low-stock threshold of 3. These are sample opening counts, not a physical stock count. `stock` means currently available units: active orders have already deducted their quantities. Zero units means sold out; a positive count at or below its threshold means low stock.

`GET /inventory` returns `{variants: [{productId, shirt, size, stock}]}` and exposes no admin notes, audit reasons, thresholds, or customer data. `GET /admin/inventory` returns:

```text
{variants: [{productId, shirt, size, stock, lowStockThreshold, version,
            updatedAt, name, emoji, colorName, history}],
 summary: {products, variants, totalStock, outOfStock, lowStock},
 meta: {initialStock: 12, defaultLowStockThreshold: 3, mockSeed: true}}
```

Patch a variant with `{stock, lowStockThreshold, version, reason?}`. Stock and threshold inputs are integers from 0 to 999999; reason is optional and limited to 240 characters. Stock returned after a cancellation can exceed the manual-entry limit because valid reserved units must always be returned. Every edit requires the version that the administrator reviewed. HTTP 409 `INVENTORY_CHANGED` requires a refresh and explicit review; a stale value is never applied automatically. The response is `{variant}` with the updated version and recent history. Threshold-only changes produce an audit movement with `delta: 0`.

Movements contain `{id, productId, shirt, size, delta, stockAfter, lowStockThreshold, version, kind, reason, orderId, at, actor}`. Kinds are `seed`, `legacy_topup`, `reserve`, `release`, and `adjustment`. Admin changes retain the configured username and reason; order changes use the system actor. The single-variant GET returns `{variant, history}`, including up to 50 recent movements.

Creating an order inserts reservations and deducts every item inside the same D1 transaction. Database guards reject insufficient stock; a failed line rolls back the order, earlier deductions and audit movements. The response is HTTP 409 `{error: {code: "INSUFFICIENT_STOCK", message, items: [{productId, shirt, size, requested, available}]}}`. An idempotent retry looks up its saved order before reserving stock, so a previously successful checkout can still be recovered when availability is now zero.

Cancelling an active order releases its reservations exactly once. Reopening a cancelled order must reacquire every item; insufficiency rolls back the entire status change and every partial reacquisition. Moving between other active statuses, including shipped, does not deduct again. SQLite triggers keep stock, movement history and the order change atomic; order creation uses [D1 `batch()` transaction rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). There are no Worker-memory locks.

The migration preserves existing order records and creates one durable reservation per legacy order/variant. Active legacy orders, including shipped orders, are deducted once; cancelled ones are marked inactive. If existing demand exceeds the mock opening stock, the migration records an explicit `legacy_topup` opening-balance adjustment to honor those orders without negative inventory. Reruns preserve later manual counts, avoid duplicate deductions and retain existing audit history. Legacy cancelled orders must pass the normal availability check when reopened.

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

Run `node --test backend/tests.mjs` with Node 22 or later, including the built-in experimental SQLite module. Tests execute actual Worker handlers, SQL triggers and migrations against a SQLite-backed D1 adapter with transactional batches. They check prices, validation, token privacy, authentication/expiry, order persistence, rate limits, CORS, all 320 variants, concurrent last-unit purchases, idempotent stock recovery, partial-order rollback, cancellation/reopening, inventory version conflicts/audits, stale reviewed order versions, and rerunnable legacy migration. These tests do not replace a deployed D1 smoke check.
