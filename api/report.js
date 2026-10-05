const { buildSql } = require('./_sql');

// Primary source: Metabase question 30328 (Target Goals report), run with its
// start_date / end_date variables. Falls back to the embedded copy of the SQL
// in _sql.js if the card can't be run.
const QUESTION_ID = Number(process.env.METABASE_QUESTION_ID || 30328);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

let tagCache = null; // { start_date: {id,type}, end_date: {id,type} }

async function mb(host, key, path, body) {
  const r = await fetch(`${host}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`Metabase ${path} returned ${r.status}`);
  if (j.error || j.status === 'failed') throw new Error(String(j.error || 'Query failed').slice(0, 600));
  return j;
}

async function getTags(host, key) {
  if (tagCache) return tagCache;
  const card = await mb(host, key, `/api/card/${QUESTION_ID}`);
  const tags = (card.dataset_query && card.dataset_query.native && card.dataset_query.native['template-tags']) || {};
  if (!tags.start_date || !tags.end_date) throw new Error(`Question ${QUESTION_ID} has no start_date / end_date variables`);
  tagCache = tags;
  return tags;
}

function toRows(j) {
  const cols = j.data.cols.map((c) => String(c.name).toLowerCase());
  return j.data.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

module.exports = async (req, res) => {
  try {
    let host = (process.env.METABASE_HOST || process.env.METABASE_URL || '').trim().replace(/\/+$/, '');
    const key = process.env.METABASE_API_KEY;
    const database = Number(process.env.METABASE_DATABASE_ID || 397);
    if (!host || !key) return res.status(500).json({ error: 'Set METABASE_HOST and METABASE_API_KEY in Vercel env vars.' });
    if (!/^https?:\/\//.test(host)) host = 'https://' + host;

    let { start, end } = req.query || {};
    if (!isRealDate(start || '') || !isRealDate(end || '')) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD dates.' });
    }
    if (start > end) [start, end] = [end, start];
    if ((Date.parse(end) - Date.parse(start)) / 86400000 > 1000) {
      return res.status(400).json({ error: 'Range is limited to about 2.7 years.' });
    }

    let rows, source, cardError = null;
    try {
      const tags = await getTags(host, key);
      const param = (name, value) => ({
        id: tags[name].id,
        type: 'date/single',
        target: ['variable', ['template-tag', name]],
        value,
      });
      const j = await mb(host, key, `/api/card/${QUESTION_ID}/query`, {
        parameters: [param('start_date', start), param('end_date', end)],
      });
      rows = toRows(j);
      source = `question ${QUESTION_ID}`;
    } catch (e) {
      cardError = e.message;
      tagCache = null;
      const j = await mb(host, key, '/api/dataset', {
        database,
        type: 'native',
        native: { query: buildSql(start, end), 'template-tags': {} },
        parameters: [],
      });
      rows = toRows(j);
      source = 'embedded sql';
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ start, end, source, card_error: cardError, rows, fetched_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
