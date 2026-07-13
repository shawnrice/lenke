import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
for (const [ts, v] of [
  ['2026-07-01T10:15:00', 5],
  ['2026-07-01T10:45:00', 7],
  ['2026-07-01T11:05:00', 9],
  ['2026-07-01T11:30:00', 11],
  ['2026-07-02T10:00:00', 100],
] as const)
  g.addVertex({ labels: ['R'], properties: { ts: parseDateTime(ts), v } });

const p = (label: string, q: string) => {
  try {
    console.log(label, JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(label, 'ERR', e.message);
  }
};

// can we stringify a DATETIME?
p('to_string(ts):', `MATCH (r:R) RETURN to_string(r.ts) AS s ORDER BY r.ts`);
// substring prefix for hour bucket (chars 1..13 -> "2026-07-01T10")
p(
  'hour bucket substring:',
  `MATCH (r:R) RETURN substring(to_string(r.ts), 0, 13) AS s ORDER BY r.ts`,
);
// implicit GROUP BY hour bucket with avg
p(
  'hourly avg grouped:',
  `MATCH (r:R) RETURN substring(to_string(r.ts), 0, 13) AS hr, avg(r.v) AS a, count(r.v) AS c ORDER BY hr`,
);
// daily bucket (chars 0..10)
p(
  'daily avg grouped:',
  `MATCH (r:R) RETURN substring(to_string(r.ts), 0, 10) AS day, avg(r.v) AS a, min(r.v) AS mn, max(r.v) AS mx ORDER BY day`,
);
