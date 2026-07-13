import { Graph, parseDateTime, parseDate } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v));
const t = (l: string, q: string, p: any = {}) => {
  try {
    console.log(l, '=>', j(query(g, q, p)));
  } catch (e: any) {
    console.log(l, 'ERR', e.code, e.message);
  }
};
// duration * float
t('P1M * 1.5', `RETURN DURATION 'P1M' * 1.5 AS x`);
t('P10D * 0.5', `RETURN DURATION 'P10D' * 0.5 AS x`);
t('P1Y / 2', `RETURN DURATION 'P1Y' / 2 AS x`); // division?
t('dur + int', `RETURN DURATION 'P1M' + 5 AS x`); // nonsense mix
t('date + int', `RETURN DATE '2020-01-01' + 5 AS x`); // date + bare int (days?)
t('date - date', `RETURN DATE '2020-01-10' - DATE '2020-01-01' AS x`); // instant - instant => duration
t('datetime + P1M (clamp+time)', `RETURN DATETIME '2020-01-31T12:00:00' + DURATION 'P1M' AS x`);
// coalesce open interval to compare - but coalesce mixed types?
t(
  'coalesce(date, datetime)',
  `RETURN coalesce(DATE '2020-01-01', DATETIME '2021-01-01T00:00:00') AS x`,
);
// CAST a string to DATE
t("CAST('2020-01-01' AS DATE)", `RETURN CAST('2020-01-01' AS DATE) AS x`);
t('CAST str AS DURATION', `RETURN CAST('P1Y' AS DURATION) AS x`);
// duration_between args swapped kinds
t(
  'dur_between(date, datetime)',
  `RETURN duration_between(DATE '2020-01-01', DATETIME '2020-02-01T00:00:00') AS x`,
);
