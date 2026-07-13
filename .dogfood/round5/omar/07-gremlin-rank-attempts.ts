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
  take,
  tail,
  Scope,
  project,
  values,
  pipe,
  count,
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

function tryIt(label: string, fn: () => unknown) {
  try {
    console.log(label, '=>', fn());
  } catch (e: any) {
    console.log(label, 'ERR', e.code, e.message);
  }
}

// A: order(local) [known broken]
tryIt(
  'A order(local).by(desc)+limit(local,3)',
  () => toArray(traversal(...base, order(Scope.local).by(Order.desc), limit(Scope.local, 3)), g)[0],
);

// B: unfold -> [k,v] tuples; order by tail(local,1)
tryIt('B unfold+order.by(tail local 1)+limit3', () =>
  toArray(
    traversal(...base, unfold(), order().by(pipe(tail(Scope.local, 1)), Order.desc), take(3)),
    g,
  ),
);

// C: unfold -> select('values')  [known broken]
tryIt('C unfold+select(values)', () => toArray(traversal(...base, unfold(), take(2)), g));

// D: project each entry k/v then order by v
tryIt('D unfold+project(k,v).by(...)', () =>
  toArray(
    traversal(
      ...base,
      unfold(),
      project('k', 'v')
        .by(pipe(limit(Scope.local, 1)))
        .by(pipe(tail(Scope.local, 1))),
    ),
    g,
  ).slice(0, 2),
);
