# Zenin Club

[Store](https://ealfaro29.github.io/zenin-club/) · [Admin](https://ealfaro29.github.io/zenin-club/#admin) · [Inventory](https://ealfaro29.github.io/zenin-club/#admin/inventory) · [Repository](https://github.com/ealfaro29/zenin-club)

A bilingual Zenin Club concept store with 16 graphic tees, product/color/size selection, a persistent bag, checkout, customer tracking, and shared order and inventory administration. The storefront, checkout and admin use a dark theme. Spanish is the default; visitors can switch to English and retain their preference.

## Architecture

- **GitHub Pages** serves the static frontend from `main:/docs`, using relative assets and hash routes.
- **Cloudflare Worker** handles checkout, tracking and authenticated admin requests. `docs/config.js` contains its public API base URL.
- **Cloudflare D1** is the source of truth for orders, fulfillment updates and inventory across devices. Checkout sends customer contact and delivery details to the API for storage.
- The browser retains the bag, language preference and customer tracking references. Admin bearer sessions use tab-scoped session storage and expire after six hours.

The Worker owns product prices, names, totals and validation. Shipping is USD 8, or free from a **pre-discount** subtotal of USD 120. `ZENIN10` applies a 10% discount. Checkout retries reuse an idempotency key to prevent duplicate orders.

Payments are simulated: no charge is made. Product specifications remain sample content. Inventory starts with a clearly labeled demo opening balance of 12 per variant and is then managed through Admin → Inventory; active existing orders are deducted during initialization. Admin updates are saved, while shipping labels, payment processing and transactional emails are not configured.

## Local development and checks

```sh
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173). The frontend needs no build step. `docs/config.js` selects the order API used by local checkout; a deployed API uses the shared D1 database.

```sh
npm run check
npm test
```

Use Node 22 or later. The backend tests run the actual Worker handlers against a SQLite-backed D1 adapter, covering prices, validation, idempotency, authentication, tracking privacy, concurrent admin updates, persistence, rate limits and CORS. SQLite may print an experimental-feature notice.

For an isolated local backend, run `npx wrangler dev --config=backend/wrangler.toml`, provide development secrets in ignored `backend/.dev.vars`, apply `backend/schema.sql` to the local D1 database, and point `docs/config.js` at the local Worker URL.

## Backend setup and deployment

`backend/wrangler.toml` configures the `zenin-club-orders` Worker and the D1 binding `DB`. After authenticating Wrangler to the owning Cloudflare account:

```sh
npm run db:migrate
npm run deploy:api
```

Configure `ADMIN_USERNAME` as a Worker variable. Store the following through interactive `wrangler secret put <NAME> --config=backend/wrangler.toml` prompts:

- `ADMIN_PASSWORD_SALT`: random salt of at least 16 characters
- `ADMIN_PASSWORD_HASH`: SHA-256 hex digest of the UTF-8 string `salt:password`
- `ADMIN_SESSION_SECRET`: random secret of at least 32 characters

Keep the actual password, salt and session secret out of frontend files and Git. The admin login uses the configured username and password at `#admin`. Set the deployed Worker URL in `docs/config.js` and confirm its `/health` endpoint before publishing the frontend.

GitHub Pages publishes `main` from `/docs`; pushing to `main` updates the store. Backend changes require their own Worker deployment. API CORS permits the GitHub Pages origin and local frontend origins on port 5173. See [backend/README.md](backend/README.md) for endpoint contracts, limits and secret-rotation behavior.

## Main files

| File | Responsibility |
| --- | --- |
| `docs/data/products.json` | Product catalog bundled into both storefront and Worker |
| `docs/app.js`, `docs/storefront-ui.js` | Storefront routes, search, product selection, carousel and navigation |
| `docs/commerce.js` | Bag, validated checkout and saved-order confirmation |
| `docs/orders-api.js`, `docs/config.js` | API client and public endpoint configuration |
| `docs/order-tracking.js` | Customer order lookup, status history and delivery details |
| `docs/admin.js`, `docs/admin-inventory.js` | Shared admin session, orders, inventory adjustments and movement history |
| `docs/inventory.js` | Cached public availability used by product, bag and checkout controls |
| `docs/i18n.js` | Spanish/English copy, product names and formatting |
| `docs/styles.css`, `docs/dark-theme.css` | Responsive storefront, checkout and dark theme |
| `backend/worker.js`, `backend/schema.sql` | Order API and D1 persistence |
| `backend/tests.mjs` | SQLite-backed backend integration tests |

## Artwork and video

The store uses the supplied Zenin logo, a transparent logo cutout, four shirt mockups and emoji prints. Emoji appearance can vary by device. Topview T1 generated the landscape black-shirt hero and vertical teal-shirt UGC clips; web copies are silent H.264 and respect reduced-motion preferences. The black-shirt hero was regenerated using the logo without its rectangular background. Full-resolution originals and generation notes remain locally in ignored `output/ugc/` and `output/topview-ugc-notes.txt`.
