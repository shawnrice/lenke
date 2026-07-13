import {
  traversal,
  V,
  has,
  in_,
  out,
  toArray,
  groupCount,
  order,
  Order,
  values,
  where,
  not,
  select,
  Scope,
  take,
  limit,
  unfold,
  project,
} from '@lenke/gremlin';

import { buildDataset } from './data.ts';

const d = buildDataset();
const g = d.g;
const X = 'i1';

// JS truth (recompute quickly)
const buyersOfX = new Set(d.purchased.filter((p) => p.item === X).map((p) => p.user));
const co = new Map<string, number>();
for (const p of d.purchased) {
  if (p.item === X) continue;
  if (buyersOfX.has(p.user)) co.set(p.item, (co.get(p.item) ?? 0) + 1);
}
const jsTop = [...co.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
console.log('JS top5:', jsTop);

// Attempt 1: groupCount into a Map, then order(local) + limit(local)
try {
  const r = toArray(
    traversal(
      V(),
      has('iid', X),
      in_('PURCHASED'),
      out('PURCHASED'),
      where(not(has('iid', X))),
      groupCount().by('iid'),
      order(Scope.local).by(Order.desc), // order map entries by value desc
      limit(Scope.local, 5),
    ),
    g,
  );
  console.log('Gremlin groupCount+order(local)+limit(local):', r);
} catch (e: any) {
  console.log('ERR attempt1:', e.code, e.message);
}
