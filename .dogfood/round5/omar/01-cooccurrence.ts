import { query } from '@lenke/gql';
import {
  traversal,
  V,
  has,
  hasLabel,
  in_,
  out,
  toArray,
  groupCount,
  order,
  Order,
  values,
  where,
  not,
  is,
  select,
  project,
  count,
  by as _byNope,
} from '@lenke/gremlin';

import { buildDataset } from './data.ts';

const d = buildDataset();
const g = d.g;
const X = 'i1'; // target item

// ---------- JS ground truth ----------
const buyersOfX = new Set(d.purchased.filter((p) => p.item === X).map((p) => p.user));
const co = new Map<string, number>();
for (const p of d.purchased) {
  if (p.item === X) continue;
  if (buyersOfX.has(p.user)) co.set(p.item, (co.get(p.item) ?? 0) + 1);
}
const jsTop = [...co.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 10);
console.log('JS top10 co-bought with', X, ':', jsTop);
console.log('buyers of', X, '=', buyersOfX.size);

// ---------- GQL ----------
const gqlRows = query(
  g,
  `
  MATCH (x:Item {iid:$x})<-[:PURCHASED]-(u:User)-[:PURCHASED]->(y:Item)
  WHERE y.iid <> $x
  RETURN y.iid AS item, count(*) AS coBought
  ORDER BY coBought DESC, item ASC
  LIMIT 10
`,
  { x: X },
);
console.log(
  'GQL top10:',
  gqlRows.map((r) => [r.item, r.coBought]),
);
