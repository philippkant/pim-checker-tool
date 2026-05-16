# Product Data Check (pim-checker)

A free tool that audits the quality of an e-commerce product catalog. Upload a
CSV, get a scored report on completeness, content quality, and consistency,
with a concrete fix and example rows for every issue.

A **kant.dev product**. The intended role: a free, shareable tool that
demonstrates MDM/PIM expertise and feeds inbound — see `kant.dev/products`.

> **Naming is a working title.** The product is "Product Data Check" and the
> repo is `pim-checker` for now. Final name + domain are Philipp's call;
> change `src/consts.ts` and `astro.config.mjs` (`site`) when decided.

## What it checks

Fully **deterministic** — the CSV is parsed in memory, columns are
auto-detected (English + German headers), and the rows are inspected. No API
keys, no model calls, nothing stored.

| Category | Checks |
| --- | --- |
| **Completeness** | title, description, price, image, SKU present for every product |
| **Content quality** | title length (10–150), description depth (≥15 words), valid numeric prices, real image URLs |
| **Consistency & identifiers** | duplicate SKUs, duplicate titles, brand recorded, GTIN/EAN present |

Each check returns pass / improve / fix with concrete counts and example
rows, plus a per-category and overall score (0–100, weighted).

Column detection covers common e-commerce and German shop exports
(`Artikelnummer`, `Bezeichnung`, `Preis`, `EAN`, ...). Delimiter is
auto-detected, so comma- and semicolon-separated files both work.

## Tech

- **Astro 5** (`output: 'server'`, `@astrojs/node` standalone adapter)
- **Tailwind 4** via `@tailwindcss/vite` — shares the kant.dev paper/ink/coral palette
- `papaparse` for CSV parsing
- Homepage is prerendered; only `POST /api/check` (multipart upload) runs on demand

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run check    # astro check
npm run build    # production build to dist/
```

`public/sample-catalog.csv` is a deliberately messy 16-row catalog used by the
"Try a sample catalog" button.

## Deploy

Built from the `Dockerfile` (Node 20 builder → Node 20 runner, standalone
server). Hosted on Coolify, same as kant.dev. The server listens on `PORT`
(default `4321`).

## Known limitations (v1)

- Reads **CSV only** — no Excel, no Shopify/marketplace API connections.
- Checks the file **as uploaded**: it does not fetch image URLs to confirm
  they resolve, validate GTIN checksums, or flag prices outside a sane range.
- Analyses at most 20,000 rows; file size capped at 8 MB.

## Roadmap

Planned, not built:

- Image-URL liveness and GTIN checksum validation.
- Excel upload and direct Shopify / marketplace connectors.
- Auto-fix export — download a corrected CSV (intended paid tier).
- Scheduled re-checks with regression alerts.
