import { Graph, parseDateTime, parseDate } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
const t = parseDateTime('2026-07-01T10:00:00');
g.addVertex({ labels: ['R'], properties: { ts: t, v: 5 } });
g.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T08:00:00'), v: 3 } });

// stored DATETIME comparison
console.log('all:', query(g, `MATCH (r:R) RETURN r.v AS v ORDER BY r.ts`));
console.log(
  'cmp:',
  query(g, `MATCH (r:R) WHERE r.ts >= DATETIME '2026-07-01T09:00:00' RETURN r.v AS v`),
);

const now = { __now: parseDateTime('2026-07-01T10:30:00') };
console.log('ct:', String(query(g, `RETURN current_timestamp AS d`, now)[0].d));
console.log(
  'window last 1h:',
  query(g, `MATCH (r:R) WHERE r.ts >= current_timestamp - DURATION 'PT1H' RETURN r.v AS v`, now),
);
console.log(
  'instant arith form:',
  query(g, `MATCH (r:R) WHERE r.ts + DURATION 'PT1H' >= current_timestamp RETURN r.v AS v`, now),
);

// regression: DATE $__now coerces to DATETIME
const dateNow = { __now: parseDate('2026-07-01') };
console.log('ct from DATE now:', String(query(g, `RETURN current_timestamp AS d`, dateNow)[0].d));
console.log('dur*1.5:', query(g, `RETURN DURATION 'P10D' * 1.5 AS d`));
console.log('dur*2:', String(query(g, `RETURN DURATION 'P10D' * 2 AS d`)[0].d));
