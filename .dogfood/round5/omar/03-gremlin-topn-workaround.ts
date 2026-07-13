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
  where,
  not,
  unfold,
  select,
  limit,
  project,
  values,
} from '@lenke/gremlin';

import { buildDataset } from './data.ts';
const d = buildDataset();
const g = d.g;
const X = 'i1';

const base = [
  V(),
  has('iid', X),
  in_('PURCHASED'),
  out('PURCHASED'),
  where(not(has('iid', X))),
  groupCount().by('iid'),
] as const;

// what does unfold of the map yield?
try {
  const r = toArray(traversal(...base, unfold(), limit(3)), g);
  console.log('unfold of map (first 3):', r);
} catch (e: any) {
  console.log('ERR unfold:', e.code, e.message);
}

// try ordering unfolded entries by select('values')
try {
  const r = toArray(
    traversal(...base, unfold(), order().by(select('values'), Order.desc), limit(5)),
    g,
  );
  console.log('unfold+order by select(values):', r);
} catch (e: any) {
  console.log('ERR order-select:', e.code, e.message);
}
