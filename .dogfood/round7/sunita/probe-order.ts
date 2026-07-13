import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
for (const [ts, v] of [
  ['2026-07-01T10:00:00', 5],
  ['2026-07-01T09:00:00', 3],
  ['2026-07-01T11:00:00', 9],
  ['2026-07-01T08:00:00', 1],
] as const)
  g.addVertex({ labels: ['R'], properties: { ts: parseDateTime(ts), v } });
const p = (l: string, q: string) => {
  try {
    console.log(l, JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', e.message);
  }
};
// does collect_list respect an ORDER BY inside the same RETURN?
p('collect plain:', `MATCH (r:R) RETURN collect_list(r.v) AS xs`);
p('collect + ORDER BY ts:', `MATCH (r:R) RETURN collect_list(r.v) AS xs ORDER BY r.ts`);
// pre-sort via WITH ... ORDER BY then collect
p('WITH order then collect:', `MATCH (r:R) WITH r ORDER BY r.ts RETURN collect_list(r.v) AS xs`);
p(
  'collect the ts too:',
  `MATCH (r:R) WITH r ORDER BY r.ts RETURN collect_list(to_string(r.ts)) AS xs`,
);
// duration_between between two stored datetimes
p(
  'dur_between:',
  `MATCH (r:R) RETURN duration_between(DATETIME '2026-07-01T08:00:00', max(r.ts)) AS d`,
);
