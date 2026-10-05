# Goal Pace

Pace tracker built on the Target Goals report (Metabase question 30328). Pick any date range, tick metrics to add them together, type a goal, see if you're on pace.

## Deploy
1. Upload this folder to a new Vercel project (framework: Other).
2. Env vars:
   - `METABASE_HOST` = https://arena-club.metabaseapp.com
   - `METABASE_API_KEY` = your Metabase API key
   - `METABASE_QUESTION_ID` = optional, defaults to 30328
   - `METABASE_DATABASE_ID` = optional, defaults to 397 (only used by the fallback)
3. Deploy.

## Data source
`/api/report?start=YYYY-MM-DD&end=YYYY-MM-DD` runs question 30328 with its `start_date` and `end_date` variables, so edits to the Metabase card (targets, filters) flow straight into the app. If the card can't be run, it falls back to the copy of the SQL in `api/_sql.js` and the header shows "embedded sql" instead of "question 30328".

Only the five intake metrics are shown; pipeline rows from the card are ignored.

`/?demo=1` runs on simulated data.
