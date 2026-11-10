# Zenin Club

Spanish/English shirt store with a shared Cloudflare D1 catalog, reusable garment bases, PNG artwork stored in Cloudflare R2, persistent orders and authenticated administration. GitHub Pages serves `/docs` from `main`.

## Launch wizard and catalog workflow

Open **Admin → Lanzamiento** (`#admin/launch`). It shows the launch checklist and opens a wizard for each step. The same wizards stay available afterwards for new shirt types, collections, designs and articles.

1. **Camisetas** (`#admin/shirts`). Create each shirt type: name, cut/type, fabric weight and sizes. Drop one PNG per color (several at once is fine; files whose name contains `espalda`/`back` become back photos). Each color's hex is detected from the PNG and can be adjusted with the color picker; it drives the dynamic backdrop behind every product photo. Back photos are optional and only needed for back prints. A third step sets the print area where artwork sits on that type.
2. **Colecciones** (`#admin/collections`). Name, description and a cover PNG used on the collection page, home tiles and menu. The accent color is detected from the cover.
3. **Diseños** (`#admin/products`). Choose the collection, upload the artwork for the front, the back or both, choose the shirt types and colors to offer and a price per shirt type, preview every combination with its backdrop, pick the main photo and the opening stock, then publish.
4. **Artículos** (`#admin/articles`, optional). Bottles, keychains and other items: name, type, optional collection, one PNG per variant (with detected color), options such as `Única` or `500 ml`, price and opening stock.

5. **Landing** (`#admin/landing`). Upload the home page hero videos; each becomes a slide with its title, text and a button that links to the shop, a collection, articles or order tracking. Several slides rotate every 9 seconds. With none, the original bundled video is shown.

Collections also have an optional **Videos** step: up to six videos shown in a reel below the cover on the collection page, playing muted as they scroll into view. Videos are MP4 (H.264) or WebM up to 50 MB; the wizard checks that the browser can play them and captures the first frame as the poster.

Archived shirt types, collections, designs and articles stay restorable from each list. **Inventario** adjusts stock per variant and **Pedidos** manages orders.

Images must be valid PNGs, up to 5 MiB, 8192 pixels per side and 16 megapixels; the wizards scale larger files down before uploading. Transparent backgrounds and consistent square framing give the best previews. Artwork and blank images are immutable, deduplicated by SHA-256, and served through the Worker; no image files or credentials are committed to Git. Saving a base updates its shared name, type, weight and color images across the catalog. Existing order snapshots retain their original images and details.

Bases support custom sizes through the API. The admin offers XS–XXXL and lets you add custom size labels. Colors in use and bases referenced by active products cannot be removed; size changes are also protected while a base is in use. Products can be archived while their order history is preserved. The former emoji catalog is archived and no demonstration products are seeded into a fresh database.

Stock is informational: zero displays **Low stock** and never prevents purchasing an offered combination. Orders allocate only available units; cancellation returns only the units actually allocated. The server owns names, prices, option validation and totals, and checkout retries use idempotency keys.

**Payments use Tilopay** (hosted payment page: card or SINPE Móvil on Tilopay's secure page) once its credentials are configured; without them the checkout saves orders without charging. See *Tilopay payments* below. Prices remain USD; the existing shipping rule is USD 8 or free from USD 120 before discounts, and `ZENIN10` applies a 10% discount. Real payment processing, shipping rates, tax settings, fiscal invoicing and transactional email must be configured separately. The newsletter reports that sign-up is not enabled.

## Tilopay payments

The store owner connects Tilopay in **Admin → Pagos** (`#admin/payments`): API user, API password and the integration key from *Integración con plataformas* in the Tilopay dashboard (the existing WooCommerce integration key works). *Probar conexión* checks them with Tilopay; saving with charging enabled verifies them first. They are stored encrypted (AES-GCM, key derived from `ADMIN_SESSION_SECRET`) and are never returned by the API; rotating `ADMIN_SESSION_SECRET` means re-entering them. Turning the switch off returns checkout to saving orders without charging. `TILOPAY_API_USER`, `TILOPAY_API_PASSWORD` and `TILOPAY_KEY` Worker secrets are an optional fallback used only until settings are saved in the admin.

Test with the Tilopay account in test mode and its test cards; the admin marks those payments `TEST`. Switch the account to production in the Tilopay dashboard to charge for real (same host and credentials for both modes). Run `npm run db:migrate:payments` before deploying the API.

How it works: checkout creates the order with payment `pending` and redirects to Tilopay; the customer returns to the storefront address the checkout was opened from. The order is marked **Pagado** only after the Worker confirms an approved transaction for the exact amount with Tilopay's `consult` API; redirect parameters alone are never trusted. Declined payments can be retried from the order tracking page (each attempt has a new `orderNumber`, which Tilopay requires). A cron every 10 minutes confirms payments of customers who closed the tab and cancels orders unpaid after 60 minutes, releasing their stock. Paid orders can be refunded from the admin order detail.

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

- Frontend: GitHub Pages publishes `/docs` from `main` at https://zeninclub.shop (`docs/CNAME`; `www` redirects to it).
- API: https://api.zeninclub.shop, a Worker custom domain declared in `backend/wrangler.toml` (DNS for zeninclub.shop is on Cloudflare). The `workers.dev` address keeps working.
- API: `npm run deploy:api`; the `DB` D1 and `DESIGNS` R2 bindings are configured in `backend/wrangler.toml`.
- Apply database migrations before deploying the matching API. For this release: `npm run db:migrate:launch` (0008, collections and articles), `npm run db:migrate:media` (0010, videos and landing), then optionally `npm run db:empty-catalog` (0009) to hide every existing product, shirt type and collection so the launch wizard starts from an empty store, then `npm run deploy:api`, then publish `/docs`. See `backend/README.md` for transactional migration requirements and API contracts.
- Keep `ADMIN_PASSWORD_SALT`, `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` as Worker secrets. `ADMIN_USERNAME` is a Worker variable. Never place secrets in frontend code or Git.

## Main files

| File | Responsibility |
| --- | --- |
| `docs/admin-studio.js` | Launch checklist and wizards for shirt types, collections, designs and articles |
| `docs/admin-inventory.js` | Per-variant stock |
| `docs/product-design.js` | Shared garment, print area, price and color-backdrop helpers |
| `docs/app.js`, `docs/storefront-ui.js`, `docs/catalog.css` | Storefront, collections, front/back composition |
| `docs/commerce.js` | Cart, option validation and checkout |
| `docs/admin.js`, `docs/order-tracking.js` | Administration and customer tracking |
| `docs/orders-api.js`, `docs/config.js` | API client and public endpoint |
| `backend/worker.js`, `backend/schema.sql` | Authoritative catalog, options, orders and storage |
| `backend/migrations/` | Database upgrades preserving existing records |
| `backend/tests.mjs` | Backend integration and migration tests |
