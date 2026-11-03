# Zenin Club

Spanish/English shirt store with a shared Cloudflare D1 catalog, reusable garment bases, PNG artwork stored in Cloudflare R2, persistent orders and authenticated administration. GitHub Pages serves `/docs` from `main`.

## Product workflow

1. Open **Admin → Camisetas base** (`#admin/bases`). Create a reusable model with its name, cut/type, fabric weight in g/m² and sizes. Add each color's name, swatch and blank garment PNG.
2. Open **Admin → Productos → Agregar producto** (`#admin/inventory`). Upload the design PNG and select the base/color combinations to offer. Enter the product name and price; the cover color, English name and opening stock are optional settings.
3. The store composes the uploaded design over each selected garment image. Product pages, cart, order tracking and administration use the same renderer. Unselected combinations cannot be purchased.

Images must be valid PNGs, up to 5 MiB, 8192 pixels per side and 16 megapixels. Transparent backgrounds and consistent square framing give the best previews. Artwork and blank images are immutable, deduplicated by SHA-256, and served through the Worker; no image files or credentials are committed to Git. Saving a base updates its shared name, type, weight and color images across the catalog. Existing order snapshots retain their original images and details.

Bases support custom sizes through the API. The admin offers XS–XXXL and lets you add custom size labels. Colors in use and bases referenced by active products cannot be removed; size changes are also protected while a base is in use. Products can be archived while their order history is preserved. The former emoji catalog is archived and no demonstration products are seeded into a fresh database.

Stock is informational: zero displays **Low stock** and never prevents purchasing an offered combination. Orders allocate only available units; cancellation returns only the units actually allocated. The server owns names, prices, option validation and totals, and checkout retries use idempotency keys.

**Payments remain in test mode.** The current checkout saves an order without charging a card. Prices remain USD; the existing shipping rule is USD 8 or free from USD 120 before discounts, and `ZENIN10` applies a 10% discount. Real payment processing, shipping rates, tax settings, fiscal invoicing and transactional email must be configured separately. The newsletter reports that sign-up is not enabled.

## Development

```sh
npm ci
npm run dev
npm run check
npm test
```

Use Node 22 or later. The frontend is buildless and runs at `http://localhost:5173`. `docs/config.js` selects the shared API. For an isolated backend, configure ignored development secrets, apply `backend/schema.sql` to local D1, run `npx wrangler dev --config=backend/wrangler.toml`, and point a local frontend configuration to that Worker. Local Wrangler uses isolated D1 and R2 storage.

Tests run actual Worker handlers against a SQLite D1 adapter and an R2 test bucket. They cover catalog and base CRUD, PNG validation/authentication, snapshots, allowed colors/sizes, zero stock, idempotency, concurrent edits and preservation of legacy orders and allocations during migration.

## Deployment

- Frontend: GitHub Pages publishes `/docs` from `main`.
- API: `npm run deploy:api`; the `DB` D1 and `DESIGNS` R2 bindings are configured in `backend/wrangler.toml`.
- Apply database migrations before deploying the matching API. See `backend/README.md` for transactional migration requirements and API contracts.
- Keep `ADMIN_PASSWORD_SALT`, `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` as Worker secrets. `ADMIN_USERNAME` is a Worker variable. Never place secrets in frontend code or Git.

## Main files

| File | Responsibility |
| --- | --- |
| `docs/admin-bases.js` | Reusable garment models, colors and image uploads |
| `docs/admin-inventory.js` | PNG product creation and per-variant stock |
| `docs/product-design.js` | Shared garment, image and size helpers |
| `docs/app.js`, `docs/storefront-ui.js` | Storefront and PNG composition |
| `docs/commerce.js` | Cart, option validation and checkout |
| `docs/admin.js`, `docs/order-tracking.js` | Administration and customer tracking |
| `docs/orders-api.js`, `docs/config.js` | API client and public endpoint |
| `backend/worker.js`, `backend/schema.sql` | Authoritative catalog, options, orders and storage |
| `backend/migrations/` | Database upgrades preserving existing records |
| `backend/tests.mjs` | Backend integration and migration tests |
