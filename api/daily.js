const { buildDailySql } = require('./_sql');

// GET /api/daily?start=YYYY-MM-DD&end=YYYY-MM-DD[&fresh=1]
// Per-day release counts (customers, customers_raw, slab_packs, slab_packs_raw,
// total_cards) using the same order/card filters as the Target Goals report.
// Powers the 80K release pace page.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (s) => DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

module.exports = async (req, res) => {
  try {
    let host = (process.env.METABASE_HOST || process.env.METABASE_URL || '').trim().replace(/\/+$/, '');
    const key = process.env.METABASE_API_KEY;
    const database = Number(process.env.METABASE_DATABASE_ID || 397);
    if (!host || !key) return res.status(500).json({ error: 'Set METABASE_HOST and METABASE_API_KEY in Vercel env vars.' });
    if (!/^https?:\/\//.test(host)) host = 'https://' + host;

    let { start, end, fresh } = req.query || {};
    fresh = fresh === '1';
    if (!isRealDate(start || '') || !isRealDate(end || '')) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD dates.' });
    }
    if (start > end) [start, end] = [end, start];
    if ((Date.parse(end) - Date.parse(start)) / 86400000 > 400) {
      return res.status(400).json({ error: 'Daily range is limited to about 13 months.' });
    }

    const r = await fetch(`${host}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        database,
        type: 'native',
        native: { query: buildDailySql(start, end), 'template-tags': {} },
        parameters: [],
        ...(fresh ? { cache_ttl: 0 } : {}),
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(`Metabase /api/dataset returned ${r.status}`);
    if (j.error || j.status === 'failed') throw new Error(String(j.error || 'Query failed').slice(0, 600));

    const cols = j.data.cols.map((c) => String(c.name).toLowerCase());
    const rows = j.data.rows.map((row) => {
      const o = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      o.day = String(o.day).slice(0, 10);
      return o;
    });

    res.setHeader('Cache-Control', fresh ? 'no-store' : 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ start, end, rows, fetched_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
};
