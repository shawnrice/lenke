import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v));
function t(label: string, q: string, expect: string, p: any = {}) {
  let got: string;
  try {
    got = j(query(g, q, p));
  } catch (e: any) {
    got = 'ERR ' + (e.code || '') + ' ' + e.message;
  }
  const ok = got.includes(expect);
  console.log(`${ok ? 'ok ' : '!! '} ${label}\n     got ${got}   expect~ ${expect}`);
}
// month clamp
t('Jan31 + P1M', `RETURN DATE '2020-01-31' + DURATION 'P1M' AS x`, '2020-02-29');
t('Jan31 + P1M (nonleap)', `RETURN DATE '2021-01-31' + DURATION 'P1M' AS x`, '2021-02-28');
t('Jan31 + P1M1D', `RETURN DATE '2020-01-31' + DURATION 'P1M1D' AS x`, '2020-03-01'); // clamp to Feb29 then +1d = Mar1
t('Mar31 - P1M', `RETURN DATE '2020-03-31' - DURATION 'P1M' AS x`, '2020-02-29');
t('Aug31 + P6M', `RETURN DATE '2020-08-31' + DURATION 'P6M' AS x`, '2021-02-28');
// order of ops: months first then days. Jan31 + P1D1M?  ISO duration always P{months}{days}, order fixed
t('Dec31 + P1M', `RETURN DATE '2020-12-31' + DURATION 'P1M' AS x`, '2021-01-31');
// negative span
t(
  'dur_between reversed',
  `RETURN duration_between(DATE '2020-04-20', DATE '2020-01-15') AS x`,
  'P-96D',
);
// leap day birthday
t('Feb29 + P1Y', `RETURN DATE '2020-02-29' + DURATION 'P1Y' AS x`, '2021-02-28');
t('Feb29 + P4Y', `RETURN DATE '2020-02-29' + DURATION 'P4Y' AS x`, '2024-02-29');
// datetime arithmetic across DST-free (no zones) - add hours over midnight
t(
  'dt + PT25H',
  `RETURN DATETIME '2020-01-01T23:30:00' + DURATION 'PT25H' AS x`,
  '2020-01-03T00:30:00',
);
// duration_between two datetimes -> seconds
t(
  'dt_between 1 day',
  `RETURN duration_between(DATETIME '2020-01-01T00:00:00', DATETIME '2020-01-02T00:00:00') AS x`,
  'PT86400S',
);
// add fractional? DURATION 'PT0.5S'
t(
  'dt + PT0.5S',
  `RETURN DATETIME '2020-01-01T00:00:00' + DURATION 'PT0.5S' AS x`,
  '2020-01-01T00:00:00.5',
);
// duration * negative
t('P1M * -2', `RETURN DURATION 'P1M' * -2 AS x`, 'P-2M');
// mixed month+day duration subtraction componentwise
t('P1M10D - P5D', `RETURN DURATION 'P1M10D' - DURATION 'P5D' AS x`, 'P1M5D');
// P1M - P40D (borrow across months? months and days separate, no normalization)
t('P1M - P40D', `RETURN DURATION 'P1M' - DURATION 'P40D' AS x`, 'P1M-40D');
// adding day to end-of-month datetime
t('date(datetime)', `RETURN date(DATETIME '2020-06-15T10:00:00') AS x`, '2020-06-15');
// current_date when __now passed as a DATE (not datetime) - misuse
try {
  console.log(
    'current_date w/ DATE __now:',
    j(
      query(g, `RETURN current_date AS x`, {
        __now: (await import('@lenke/core')).parseDate('2026-07-12'),
      }),
    ),
  );
} catch (e: any) {
  console.log('current_date w/ DATE __now ERR', e.code, e.message);
}
