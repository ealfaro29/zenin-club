# Zenin Club

[Live store](https://ealfaro29.github.io/zenin-club/) · [Repository](https://github.com/ealfaro29/zenin-club)

A responsive streetwear concept store inspired by the expressive product presentation of [Cool Shirtz](https://shirtz.cool/) and the spare navigation and collection structure of [PLEASURES](https://pleasuresnow.com/).

## Run locally

```sh
cd '/Users/tbnalfaro/Developer/Codex Projects/29 Zenin Club'
npm run dev
```

Open http://localhost:5173. No dependency installation or build step is needed. `npm run check` checks JavaScript syntax.

## Included

- User-supplied Zenin Club logo and four shirt mockups, converted to optimized WebP assets
- 16 emoji graphic tees in Food Court, Mood Swings, Everyday Objects, and After Hours
- Responsive home, collection, and product views with hash-based links
- Search, price/name sorting, collection filters, quick add, size guide, and four color choices
- Browser-persistent shopping bag with quantity controls and removal
- $8 simulated shipping, free shipping at $120, and a `ZENIN10` demo discount
- Validated demo checkout and simulated order confirmation
- Local newsletter signup feedback

## Mockup boundaries

This is a static demo. There is no payment provider, real inventory, order fulfillment, email service, or backend. Checkout form details stay in browser memory and are never sent to a server. The bag persists in localStorage; placing a demo order clears it. Prices, sizing, fabric/care copy, and shipping are placeholder content. Emoji are rendered by the visitor's device and may vary slightly between platforms.

## Edit

- `docs/data/products.json`: products and collection assignments
- `docs/app.js`: storefront views, search, product configuration, and routing
- `docs/commerce.js`: shopping bag and demo checkout
- `docs/styles.css`: design and responsive layout
- `docs/assets/`: supplied logo and shirt bases
- `docs/.nojekyll`: serves the static store directly through GitHub Pages

Original supplied files remain in `/Users/tbnalfaro/29 zenin/Shirts`.

## Deployment

GitHub Pages publishes `main` from `/docs`. Push changes to `main` to update the store. The app uses relative asset paths and hash routes, so it works under `/zenin-club/` without a build step or hosting service dependencies.
