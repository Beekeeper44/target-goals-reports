// GET /api/metabase?id=30328&month=9&year=2026
//
// Runs a saved Metabase question server-side so the API key never reaches the
// browser. Required environment variables:
//   METABASE_HOST     https://arena-club.metabaseapp.com
//   METABASE_API_KEY  mb_...

const ALLOWED_QUESTIONS = [30328]; // add IDs as more cards point at this tool
const DEFAULT_QUESTION = 30328;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const host = (process.env.METABASE_HOST || '').replace(/\/+$/, '');
  const key = process.env.METABASE_API_KEY;

  if (!host || !key) {
    return res.status(500).json({ error: 'server is missing METABASE_HOST or METABASE_API_KEY' });
  }

  const id = parseInt(req.query.id, 10) || DEFAULT_QUESTION;
  if (!ALLOWED_QUESTIONS.includes(id)) {
    return res.status(400).json({ error: `question ${id} is not allowed by this endpoint` });
  }

  // Question 30328 declares {{report_month}} (Text) and {{report_year}} (Number).
  // report_month accepts a month name; report_year is a plain number.
  const MONTH_NAMES = ['january','february','march','april','may','june',
                       'july','august','september','october','november','december'];

  const parameters = [];
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);

  if (month >= 1 && month <= 12) {
    parameters.push({
      type: 'category',
      target: ['variable', ['template-tag', 'report_month']],
      value: MONTH_NAMES[month - 1]
    });
  }
  if (year >= 2000 && year <= 2100) {
    parameters.push({
      type: 'number/=',
      target: ['variable', ['template-tag', 'report_year']],
      value: year
    });
  }

  const run = (body) =>
    fetch(`${host}/api/card/${id}/query/json`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  try {
    let r = await run(parameters.length ? { parameters } : {});

    // If Metabase rejects the parameters, retry once without them so the card's
    // own default period still comes back rather than an error page.
    if (!r.ok && parameters.length) r = await run({});

    const text = await r.text();

    if (!r.ok) {
      return res.status(r.status).json({ error: `metabase returned ${r.status}: ${text.slice(0, 300)}` });
    }

    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'metabase returned a non-JSON response' });
    }

    if (rows && rows.error) {
      return res.status(502).json({ error: String(rows.error).slice(0, 300) });
    }

    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'request to metabase failed' });
  }
}
