// GET /api/metabase?id=30328&month=8&year=2026[&debug=1]
//
// Runs a saved Metabase question server-side so the API key never reaches the
// browser. Required environment variables:
//   METABASE_HOST     https://arena-club.metabaseapp.com
//   METABASE_API_KEY  mb_...
//
// Question 30328 declares {{report_month}} (Text) and {{report_year}} (Number)
// inside optional [[ ]] blocks. Two things matter:
//   1. Metabase binds parameters by the template tag's `id`, not its name, so
//      the card is read first and the real ids are used.
//   2. report_month is sent as 'YYYY-MM' — per the question's own precedence
//      rules a full year-month carries its own year, so the month cannot be
//      resolved against the wrong year.
// If the card still comes back for the wrong period, the run is repeated
// through /api/dataset with the same native query and parameters.

const ALLOWED_QUESTIONS = [30328];
const DEFAULT_QUESTION = 30328;

const paramType = (tagType) => {
  if (tagType === 'number') return 'number/=';
  if (tagType === 'date') return 'date/single';
  return 'category'; // text
};

const periodOf = (rows) => {
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (k.toLowerCase() === 'report_month' && r[k]) return String(r[k]);
    }
  }
  return null;
};

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

  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);
  const wantMonth = month >= 1 && month <= 12 && year >= 2000 && year <= 2100
    ? `${year}-${String(month).padStart(2, '0')}`
    : null;

  // template tag name -> value to send
  const values = {};
  if (wantMonth) values.report_month = wantMonth; // '2026-08' carries its own year
  if (year >= 2000 && year <= 2100) values.report_year = year;

  const headers = { 'x-api-key': key, 'Content-Type': 'application/json' };

  try {
    // 1. Read the card: template tag ids, the native query, and the database id.
    const cardRes = await fetch(`${host}/api/card/${id}`, { headers });
    if (!cardRes.ok) {
      const t = await cardRes.text();
      return res.status(cardRes.status).json({ error: `could not read card ${id}: ${t.slice(0, 200)}` });
    }
    const card = await cardRes.json();
    const native = card?.dataset_query?.native || {};
    const tags = native['template-tags'] || {};

    const parameters = [];
    const skipped = [];
    for (const [name, value] of Object.entries(values)) {
      const tag = tags[name];
      if (!tag) { skipped.push(name); continue; }
      parameters.push({
        id: tag.id,
        name,
        slug: name,
        type: paramType(tag.type),
        target: ['variable', ['template-tag', name]],
        value
      });
    }

    if (req.query.debug) {
      return res.status(200).json({
        question: id,
        requested_period: wantMonth,
        template_tags: Object.entries(tags).map(([n, t]) => ({ name: n, id: t.id, type: t.type })),
        parameters_sent: parameters,
        tags_not_found: skipped
      });
    }

    // 2. Run the saved card with the bound parameters.
    const r = await fetch(`${host}/api/card/${id}/query/json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parameters })
    });
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
    if (!Array.isArray(rows)) rows = [];

    // 3. If the saved-card run ignored the parameters, run the same native
    //    query directly through /api/dataset, which always honours them.
    if (wantMonth && rows.length && periodOf(rows) && periodOf(rows) !== wantMonth) {
      const ds = await fetch(`${host}/api/dataset`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'native',
          database: card.database_id,
          native: { query: native.query, 'template-tags': tags },
          parameters
        })
      });
      const dsText = await ds.text();
      if (ds.ok) {
        let payload;
        try { payload = JSON.parse(dsText); } catch { payload = null; }
        const cols = payload?.data?.cols;
        const dataRows = payload?.data?.rows;
        if (Array.isArray(cols) && Array.isArray(dataRows)) {
          const mapped = dataRows.map((row) => {
            const o = {};
            cols.forEach((c, i) => { o[c.name] = row[i]; });
            return o;
          });
          if (mapped.length && periodOf(mapped) === wantMonth) {
            return res.status(200).json(mapped);
          }
          if (mapped.length) rows = mapped;
        }
      }
    }

    if (skipped.length) {
      return res.status(200).json({
        rows,
        warning: `question ${id} has no template tag named ${skipped.join(', ')}`
      });
    }

    return res.status(200).json(rows);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'request to metabase failed' });
  }
}
