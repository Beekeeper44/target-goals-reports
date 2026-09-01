// GET /api/metabase?id=30328&report_month=august&report_year=2026[&debug=1]
//
// Runs a saved Metabase question server-side so the API key never reaches the
// browser. Required environment variables:
//   METABASE_HOST     https://arena-club.metabaseapp.com
//   METABASE_API_KEY  mb_...
//
// Question 30328 declares {{report_month}} and {{report_year}} (both Text)
// inside optional [[ ]] blocks. Metabase matches a parameter by the template
// tag's `id`, so the card is read first — the id lives in different places
// depending on version, hence the several lookups in findMeta(). If none of
// them turn it up the parameters are still sent by target alone, and the run
// is repeated through /api/dataset if the wrong period comes back.

// Snowflake can take a while; the default 10s function timeout is too short.
// 60 is the maximum on the Hobby plan — a higher value fails the build.
export const config = { maxDuration: 60 };

const ALLOWED_QUESTIONS = [30328];
const DEFAULT_QUESTION = 30328;

const paramType = (tagType) => {
  if (tagType === 'number') return 'number/=';
  if (tagType === 'date') return 'date/single';
  return 'category'; // text
};

const periodOf = (rows) => {
  for (const r of rows || []) {
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

  // Values are passed through exactly as typed so the question's own parsing
  // rules apply: 'august', 'Aug', '2026-08', '2026-08-15', '8'.
  const rawMonth = (req.query.report_month ?? '').toString().trim();
  const rawYear = (req.query.report_year ?? '').toString().trim();
  const month = parseInt(req.query.month, 10);
  const year = parseInt(req.query.year, 10);

  const values = {};
  if (rawMonth) values.report_month = rawMonth;
  else if (month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
    values.report_month = `${year}-${String(month).padStart(2, '0')}`;
  }
  if (rawYear) values.report_year = rawYear;
  else if (year >= 2000 && year <= 2100) values.report_year = String(year);

  // Only used to decide whether the fallback run is needed. A bare month name
  // has no unambiguous expected period, so that check is skipped.
  const wantMonth = /^\d{4}-\d{2}$/.test(values.report_month || '') ? values.report_month : null;

  const headers = { 'x-api-key': key, 'Content-Type': 'application/json' };

  try {
    // 1. Read the card. Template tag metadata lives in different shapes across
    //    Metabase versions, so gather every source before giving up on an id.
    let card = null;
    const cardRes = await fetch(`${host}/api/card/${id}`, { headers });
    if (cardRes.ok) {
      card = await cardRes.json();
    }

    const native = card?.dataset_query?.native || {};
    const tags = native['template-tags'] || native.template_tags || {};
    const cardParams = Array.isArray(card?.parameters) ? card.parameters : [];

    const findMeta = (name) => {
      const t = tags[name];
      if (t && t.id) return { id: t.id, type: paramType(t.type), from: 'template-tags' };

      const p = cardParams.find((p) => {
        if (p.slug === name || p.name === name) return true;
        const tgt = p.target;
        return Array.isArray(tgt) && Array.isArray(tgt[1]) && tgt[1][1] === name;
      });
      if (p && p.id) return { id: p.id, type: p.type || 'category', from: 'card.parameters' };

      return null;
    };

    const parameters = [];
    const unresolved = [];
    for (const [name, value] of Object.entries(values)) {
      const meta = findMeta(name);
      if (meta) {
        parameters.push({
          id: meta.id,
          name,
          slug: name,
          type: meta.type,
          target: ['variable', ['template-tag', name]],
          value
        });
      } else {
        // No id available — send by target alone rather than dropping the
        // filter. Worst case Metabase ignores it and the fallback run below
        // catches the wrong period.
        unresolved.push(name);
        parameters.push({
          name,
          slug: name,
          type: 'category',
          target: ['variable', ['template-tag', name]],
          value
        });
      }
    }

    if (req.query.debug) {
      return res.status(200).json({
        question: id,
        card_readable: !!card,
        card_keys: card ? Object.keys(card).slice(0, 40) : [],
        dataset_query_type: card?.dataset_query?.type ?? null,
        has_native_query: !!native.query,
        template_tag_names: Object.keys(tags),
        card_parameters: cardParams.map((p) => ({ id: p.id, name: p.name, slug: p.slug, type: p.type })),
        values_sent: values,
        parameters_sent: parameters,
        unresolved_ids: unresolved,
        requested_period: wantMonth
      });
    }

    // 2. Run the saved card.
    const r = await fetch(`${host}/api/card/${id}/query/json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parameters })
    });
    const text = await r.text();

    let rows = null;
    if (r.ok) {
      try { rows = JSON.parse(text); } catch { rows = null; }
      if (rows && rows.error) rows = null;
    }
    if (!Array.isArray(rows)) rows = null;

    // 3. Fall back to running the native query directly. This path always
    //    honours parameters, so it covers both a rejected card run and a card
    //    run that silently ignored the filters.
    const needsFallback =
      !rows || (wantMonth && rows.length && periodOf(rows) && periodOf(rows) !== wantMonth);

    if (needsFallback && native.query && card?.database_id) {
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
        let payload = null;
        try { payload = JSON.parse(dsText); } catch { payload = null; }
        const cols = payload?.data?.cols;
        const dataRows = payload?.data?.rows;
        if (Array.isArray(cols) && Array.isArray(dataRows)) {
          const mapped = dataRows.map((row) => {
            const o = {};
            cols.forEach((c, i) => { o[c.name] = row[i]; });
            return o;
          });
          if (mapped.length) rows = mapped;
        } else if (payload?.error) {
          return res.status(502).json({ error: String(payload.error).slice(0, 300) });
        }
      }
    }

    if (!rows) {
      return res.status(r.ok ? 502 : r.status).json({
        error: `metabase could not run question ${id}: ${text.slice(0, 300)}`
      });
    }

    const got = periodOf(rows);
    if (wantMonth && got && got !== wantMonth) {
      return res.status(200).json({
        rows,
        warning: `filters did not bind — the question returned ${got} instead of ${wantMonth}. Check /api/metabase?id=${id}&debug=1`
      });
    }

    return res.status(200).json(rows);
  } catch (e) {
    return res.status(502).json({ error: e.message || 'request to metabase failed' });
  }
}
