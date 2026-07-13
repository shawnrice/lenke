import { Graph, parseDate, parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
function t(label: string, q: string, params: any = {}) {
  try {
    console.log(
      label,
      '=>',
      JSON.stringify(query(g, q, params), (k, v) => (v && v.kind ? String(v) + `(${v.kind})` : v)),
    );
  } catch (e: any) {
    console.log(label, 'ERR:', e.code || '', e.message);
  }
}
// date-part extraction candidates
t('year()', `RETURN year(DATE '1990-03-15') AS x`);
t('month()', `RETURN month(DATE '1990-03-15') AS x`);
t('day()', `RETURN day(DATE '1990-03-15') AS x`);
t('date.year prop', `RETURN (DATE '1990-03-15').year AS x`);
t('extract', `RETURN extract(YEAR FROM DATE '1990-03-15') AS x`);
t('duration_between dates', `RETURN duration_between(DATE '1990-03-15', DATE '2026-07-12') AS x`);
t('duration.years', `RETURN duration(DURATION 'P36Y4M') AS x`);
// duration component access
t('dur.months prop', `RETURN (DURATION 'P14M').months AS x`);
// age via division of days
t('age days/365.25', `RETURN duration_between(DATE '1990-03-15', DATE '2026-07-12') AS d`);
// cast a date to string then substring the month/day
t('to_string(date)', `RETURN to_string(DATE '1990-03-15') AS x`);
t('substring date str', `RETURN substring(to_string(DATE '1990-03-15'), 6, 5) AS x`);
// current_date arithmetic
t('current_date + P30D', `RETURN current_date + DURATION 'P30D' AS x`, now);
t('current_timestamp', `RETURN current_timestamp AS x`, now);
t('local_timestamp', `RETURN local_timestamp AS x`, now);
// duration comparison / to number
t('to_integer(duration)', `RETURN to_integer(DURATION 'P30D') AS x`);
t('to_float(duration)', `RETURN to_float(DURATION 'P30D') AS x`);
