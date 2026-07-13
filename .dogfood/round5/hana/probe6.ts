import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v));
const t = (l: string, q: string) => {
  try {
    console.log(l, '=>', j(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', e.code, e.message);
  }
};
t('P10D * 2.9  (expect P29D or err; trunc=>P20D)', `RETURN DURATION 'P10D' * 2.9 AS x`);
t('P10D * -1.9 (trunc=>P-10D)', `RETURN DURATION 'P10D' * -1.9 AS x`);
t('P10D * 0.9  (trunc=>PT0S)', `RETURN DURATION 'P10D' * 0.9 AS x`);
t('P1D * 2.5', `RETURN DURATION 'P1D' * 2.5 AS x`);
t('P100D * 1.5 (expect P150D; trunc=>P100D)', `RETURN DURATION 'P100D' * 1.5 AS x`);
