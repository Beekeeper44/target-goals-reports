// GET /api/metabase?id=30328&month=8&year=2026[&debug=1]
//
// Runs a saved Metabase question server-side so the API key never reaches the
// browser. Required environment variables:
//   METABASE_HOST     https://arena-club.metabaseapp.com
//   METABASE_API_KEY  mb_...
//
// Question 30328 declares {{report_month}} (Text) and {{report_year}} (Number).
// Metabase silently ignores parameters whose `id` does not match the card's
// template tag, so this reads the card definition first and binds by real id.

const ALLOWED_QUESTIONS = [30328];
const DEFAULT_QUESTION = 30328;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

// template tag name -> how to build its value from the request
const TAG_BINDINGS = {
  report_month: (q) => {
    const m = parseInt(q.month, 10);
    return m >= 1 && m <= 12 ? MONTH_NAMES[m - 1] : null;
  },
  report_year: (q) => {
    const y = parseInt(q.year, 10);
    return y >= 2000 && y <= 2100 ? y : null;
  }
};

const paramType = (tagType) => {
  if (tagType === 'number') return 'number/=';
  if (tagType === 'date') return 'date/single';
  return 'category'; // text
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

  const headers = { 'x-api-key': key, 'Content-Type': 'application/json' };

  try {
    // 1. Read the card so parameters can be bound to real template-tag ids.
    let tags = {};
    const cardRes = await fetch(`${host}/api/card/${id}`, { headers });
    if (cardRes.ok) {
      const card = await cardRes.json();
      tags = card?.dataset_query?.native?.['template-tags'] || {};
    }

    const parameters = [];
    const skipped = [];
    for (const [name, build] of Object.entries(TAG_BINDINGS)) {
      const value = build(req.query);
      if (value === null || value === undefined) continue;
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

    // /api/metabase?debug=1 shows exactly what the card declares and what we send
    if (req.query.debug) {
      return res.status(200).json({
        question: id,
        template_tags: Object.entries(tags).map(([n, t]) => ({ name: n, id: t.id, type: t.type })),
        parameters_sent: parameters,
        tags_not_found: skipped
      });
    }

    // 2. Run it. No silent retry without parameters — a filter that fails to
    //    bind should surface as an error, not as data for the wrong month.
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

    if (skipped.length) {
      return res.status(200).json({
        rows: Array.isArray(rows) ? rows : [],
        warning: `question ${id} has no template tag named ${skipped.join(', ')}`
      });
    }

    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'request to metabase failed' });
  }
}
