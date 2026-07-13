import { Graph, parseDate, parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
function t(label: string, q: string, params: any = {}) {
  try {
    console.log(
      label,
      '=>',
      JSON.stringify(query(g, q, params), (k, v) => (v && v.kind ? String(v) : v)),
    );
  } catch (e: any) {
    console.log(label, 'ERR:', e.code || '', e.message);
  }
}
// tenure > 5 years filter via duration comparison (docs say UNKNOWN)
t(
  'dur > dur filter',
  `RETURN 1 AS x WHERE duration_between(DATE '2019-02-01', DATE '2026-07-12') > DURATION 'P5Y'`,
);
t('dur >= dur', `RETURN (DURATION 'P2000D' >= DURATION 'P5Y') AS x`);
t('dur = dur', `RETURN (DURATION 'P2000D' = DURATION 'P2000D') AS x`);
// compare via date arithmetic instead: is hired + 5y <= today?
t('date+5y <= today', `RETURN (DATE '2019-02-01' + DURATION 'P5Y' <= current_date) AS x`, now);
// anniversary: substring month-day trick
t('anniv md today', `RETURN substring(to_string(current_date), 6, 5) AS md`, now);
// employees w/ anniversary next 30 days: compare md strings (breaks across year boundary)
// duration * int
t('dur * int', `RETURN DURATION 'P1M' * 12 AS x`);
t('int * dur', `RETURN 12 * DURATION 'P1M' AS x`);
// datetime - datetime
t('dt - dt', `RETURN (DATETIME '2024-06-01T00:00:00' - DATETIME '2019-01-01T00:00:00') AS x`);
// null handling for open interval (vto IS NULL)
t('null < date', `RETURN (null < DATE '2020-01-01') AS x`);
// coalesce vto with far-future for as-of
t('coalesce open', `RETURN coalesce(null, DATE '9999-12-31') AS x`);
// date comparison with coalesced open interval
t('asof open', `RETURN (DATE '2023-06-01' < coalesce(null, DATE '9999-12-31')) AS x`);
// order by duration
t('order by dur', `FOR d IN [DURATION 'P5D', DURATION 'P2D', DURATION 'P10D'] RETURN d ORDER BY d`);
// min/max duration
t('max dur', `FOR d IN [DURATION 'P5D', DURATION 'P2D', DURATION 'P10D'] RETURN max(d) AS m`);
// sum of durations (total tenure)
t('sum dur', `FOR d IN [DURATION 'P5D', DURATION 'P2D', DURATION 'P10D'] RETURN sum(d) AS m`);
