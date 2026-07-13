import { query } from '@lenke/gql';

import { buildDataset } from './data.ts';
const d = buildDataset();
const g = d.g;

// JS avg rating for the top-5 most-rated items
const sum = new Map<string, number>();
const cnt = new Map<string, number>();
for (const r of d.rated) {
  sum.set(r.item, (sum.get(r.item) ?? 0) + r.rating);
  cnt.set(r.item, (cnt.get(r.item) ?? 0) + 1);
}
const jsAvg = [...cnt.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([i, n]) => [i, +(sum.get(i)! / n).toFixed(4), n]);
console.log('JS avg (top rated):', jsAvg);

const gql = query(
  g,
  `
  MATCH (:User)-[r:RATED]->(i:Item)
  WITH i.iid AS item, avg(r.rating) AS ar, count(*) AS n
  ORDER BY n DESC LIMIT 5
  RETURN item, ar, n`,
);
console.log(
  'GQL avg:',
  gql.map((r) => [r.item, +Number(r.ar).toFixed(4), r.n]),
);

// overall max avg to confirm the empty HAVING was correct
const maxAvg = Math.max(
  ...[...sum.keys()].filter((k) => cnt.get(k)! >= 50).map((k) => sum.get(k)! / cnt.get(k)!),
);
console.log(
  'max avg among items with >=50 ratings:',
  +maxAvg.toFixed(4),
  '(HAVING ar>=3.5 empty is correct if <3.5)',
);
