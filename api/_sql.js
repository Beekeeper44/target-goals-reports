// Same logic as the Metabase "target goals" card, with the month/year
// selectors removed: the app always sends an explicit start + end date.
// start/end are validated as YYYY-MM-DD in report.js before they get here.
function buildSql(start, end) {
  return SQL.replace('__START__', start).replace('__END__', end);
}

const SQL = `
WITH
bounds AS (
  SELECT
    LEAST(x.s, x.e)                           AS range_start,
    GREATEST(x.s, x.e)                        AS range_end,
    DATEADD(day, 1, GREATEST(x.s, x.e))::date AS range_next
  FROM (SELECT '__START__'::date AS s, '__END__'::date AS e) x
),

targets_by_month AS (
  SELECT * FROM (VALUES
    (DATE '2026-04-01', 'customers',      9350,   9700,   10000,  'monthly'),
    (DATE '2026-04-01', 'customers_raw',  NULL,   NULL,   NULL,   'monthly'),
    (DATE '2026-04-01', 'slab_packs',     141500, 148500, 155500, 'monthly'),
    (DATE '2026-04-01', 'slab_packs_raw', NULL,   NULL,   NULL,   'monthly'),
    (DATE '2026-04-01', 'total_cards',    151000, 158500, 167000, 'monthly')
  ) AS v(target_month, metric, base, target, north_star, basis)
),

cal AS (
  SELECT
    d.dt,
    DATE_TRUNC('month', d.dt)::date                     AS mon,
    DAYOFWEEKISO(d.dt) BETWEEN 1 AND 5                  AS is_biz,
    d.dt BETWEEN b.range_start AND b.range_end          AS in_range,
    d.dt <= LEAST(CURRENT_TIMESTAMP::date, b.range_end) AS is_elapsed
  FROM (
    SELECT DATEADD(day, ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1,
                   DATE_TRUNC('month', b0.range_start))::date AS dt
    FROM bounds b0
    CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 1100))
  ) d
  CROSS JOIN bounds b
  WHERE d.dt <= LAST_DAY(b.range_end)
),

range_months AS (
  SELECT
    mon,
    COUNT_IF(is_biz)                             AS month_biz_days,
    COUNT_IF(is_biz AND in_range)                AS range_biz_days,
    COUNT_IF(is_biz AND in_range AND is_elapsed) AS elapsed_biz_days
  FROM cal
  GROUP BY mon
  HAVING COUNT_IF(in_range) > 0
),

biz_days AS (
  SELECT SUM(range_biz_days) AS total_biz_days, SUM(elapsed_biz_days) AS elapsed_biz_days
  FROM range_months
),

target_pick AS (
  SELECT
    rm.mon,
    tbm.metric,
    COALESCE(MAX(IFF(tbm.target_month <= rm.mon, tbm.target_month, NULL)), MIN(tbm.target_month)) AS target_month
  FROM range_months rm
  CROSS JOIN targets_by_month tbm
  GROUP BY rm.mon, tbm.metric
),

targets AS (
  SELECT
    p.metric,
    MAX(t.basis)                                                AS basis,
    LISTAGG(DISTINCT TO_CHAR(t.target_month, 'YYYY-MM'), ', ')  AS targets_month,
    SUM(IFF(t.basis = 'daily', t.base,       t.base       / NULLIF(rm.month_biz_days, 0)) * rm.range_biz_days)   AS base,
    SUM(IFF(t.basis = 'daily', t.target,     t.target     / NULLIF(rm.month_biz_days, 0)) * rm.range_biz_days)   AS target,
    SUM(IFF(t.basis = 'daily', t.north_star, t.north_star / NULLIF(rm.month_biz_days, 0)) * rm.range_biz_days)   AS north_star,
    SUM(IFF(t.basis = 'daily', t.target,     t.target     / NULLIF(rm.month_biz_days, 0)) * rm.elapsed_biz_days) AS expected_by_now
  FROM target_pick p
  JOIN targets_by_month t ON t.metric = p.metric AND t.target_month = p.target_month
  JOIN range_months rm ON rm.mon = p.mon
  GROUP BY p.metric
),

order_items_all AS (
  SELECT order_id, card_id FROM APP_PROD.ADMIN.ORDER_ITEMS  WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
  UNION
  SELECT order_id, card_id FROM APP_PROD.PUBLIC.ORDER_ITEMS WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
),

order_base AS (
  SELECT
    co.id,
    CASE
      WHEN co.user_id = '00838bfd-7979-41bd-81f5-c6777c32d6c4' THEN 'slab_packs'
      WHEN co.user_id IN (
        '6b651925-1838-4253-805b-0a57d885f35d',
        '2be3701a-eb2d-4a68-b743-3e425806f994',
        '3810644b-0af4-497a-bfba-e20d2a310635'
      ) THEN NULL
      ELSE 'customers'
    END AS grp
  FROM APP_PROD.PUBLIC.CATEGORY_ORDERS co
  LEFT JOIN APP_PROD.ADMIN.ORDERS ao
    ON ao.id = co.id
   AND NOT COALESCE(ao._SNOWFLAKE_DELETED, FALSE)
  WHERE NOT COALESCE(co._SNOWFLAKE_DELETED, FALSE)
    AND co.kind IN ('submission', 'submit_and_return')
    AND co.number NOT IN (50, 2275, 337)
    AND ao.ready_to_reveal_email_sent_at IS NOT NULL
    AND CONVERT_TIMEZONE('UTC','America/Los_Angeles', ao.ready_to_reveal_email_sent_at)::date >= (SELECT range_start FROM bounds)
    AND CONVERT_TIMEZONE('UTC','America/Los_Angeles', ao.ready_to_reveal_email_sent_at)::date <  (SELECT range_next  FROM bounds)
    AND NOT EXISTS (
      SELECT 1
      FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING ica
      JOIN APP_PROD.PUBLIC.CATEGORY_ORDER_ITEMS coi ON coi.id = ica.buy_order_item_id
      WHERE NOT COALESCE(ica._SNOWFLAKE_DELETED, FALSE)
        AND ica.kind = 'repack_offer'
        AND coi.category_order_id = co.id
    )
),

order_cards AS (
  SELECT ob.grp, oi.card_id, NOT COALESCE(c.is_pre_graded, FALSE) AS is_raw
  FROM order_base ob
  JOIN order_items_all oi ON oi.order_id = ob.id
  LEFT JOIN APP_PROD.ADMIN.CARDS c
    ON c.id = oi.card_id
   AND NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)
  WHERE ob.grp IS NOT NULL
),

order_actuals AS (
  SELECT grp AS metric, CAST(COUNT(*) AS numeric) AS qty FROM order_cards GROUP BY grp
  UNION ALL
  SELECT grp || '_raw', CAST(COUNT(*) AS numeric) FROM order_cards WHERE is_raw GROUP BY grp
  UNION ALL
  SELECT 'total_cards', CAST(COUNT(*) AS numeric) FROM order_cards
),

all_actuals AS (
  SELECT * FROM order_actuals
)

SELECT
  bd.range_start,
  bd.range_end,
  t.targets_month,
  t.metric,
  t.basis,
  COALESCE(a.qty, 0)        AS current_total,
  ROUND(t.base)             AS base,
  ROUND(t.target)           AS target,
  ROUND(t.north_star)       AS north_star,
  ROUND(t.expected_by_now)  AS expected_by_now,
  b.elapsed_biz_days,
  b.total_biz_days
FROM targets t
LEFT JOIN all_actuals a ON a.metric = t.metric
CROSS JOIN biz_days b
CROSS JOIN bounds bd
`;

module.exports = { buildSql };
