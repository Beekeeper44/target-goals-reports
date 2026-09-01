# Target Goals Reports

Arena Club internal tool. Monthly metric report driven by Metabase question **30328**.

Columns: `METRIC`, `CURRENT_TOTAL`, `ELAPSED_BIZ_DAYS`, `DAILY_AVG`, `PROMO`.
Metrics render in two blocks — INTAKE (customers, customers_raw, slab_packs,
slab_packs_raw, total_cards) and PIPELINE (process, scan, vault, ship). Anything
else the question returns lands in an OTHER block so no row is dropped.

`PROMO` is typed in the browser. Entering a number adds it to `CURRENT_TOTAL`
(shown in green) and recalculates `DAILY_AVG`. Promo values live in the page
session only — a refresh clears them.

## Layout

```
public/index.html    single-file app, logo embedded as base64
api/metabase.js      serverless proxy that runs the saved question
```

## Environment variables

Vercel → Project → Settings → Environment Variables (all environments):

| Name | Value |
| --- | --- |
| `METABASE_HOST` | `https://arena-club.metabaseapp.com` (no trailing slash) |
| `METABASE_API_KEY` | `mb_...` from Metabase → Admin → Settings → API keys |

The API key needs a group with read access to the collection holding question
30328. It is only ever read server-side; the browser never sees it.

## Deploy

```bash
npm i -g vercel
vercel link
vercel env add METABASE_HOST
vercel env add METABASE_API_KEY
vercel --prod
```

Local run: `vercel dev` (reads `.env.local`, see `.env.example`).

Opening `public/index.html` straight off disk has no `/api` route, so the app
falls back to demo data and says so in the top-right meta line.

## Adding questions

`api/metabase.js` whitelists question IDs in `ALLOWED_QUESTIONS`. Add the ID
there, then change `QUESTION_ID` near the top of the script block in
`public/index.html`.

## Month and year filters

The proxy sends `month` and `year` as template-tag parameters. If question 30328
does not declare those tags, Metabase rejects them and the proxy retries once
without, returning the card's own period. To make the filters actually filter,
add `{{month}}` and `{{year}}` number variables to the question's SQL.
