import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  in_,
  values,
  count,
  sum,
  min,
  max,
  mean,
  fold,
  unfold,
  group,
  groupCount,
  aggregate,
  store,
  cap,
  barrier,
  dedupe,
  order,
  Order,
  sample,
  by,
  Scope,
  select,
  project,
  pipe,
  local,
  gt,
  id,
  label as labelStep,
} from '@lenke/gremlin';

import { res, raw, label, g } from './util.ts';

console.log('\n===== AGGREGATION / BARRIER =====');

// groupCount by label
label('groupCount().by(label)', raw(traversal(V(), groupCount().by(labelStep()))), [
  { PERSON: 4, SOFTWARE: 2 },
]);

// groupCount of created-thing names
label(
  'out(CREATED).groupCount().by(name)',
  raw(traversal(V(), out('CREATED'), groupCount().by('name'))),
  [{ lop: 3, ripple: 1 }],
);

// group by lang -> list of names (software)
label(
  'group().by(lang).by(name) software',
  raw(traversal(V(), hasLabel('SOFTWARE'), group().by('lang').by('name'))),
  [{ java: ['lop', 'ripple'] }],
);

// group().by(lang).by(count()) -- KNOWN broken per charter; record actual
label(
  'group().by(lang).by(count()) [known-broken]',
  raw(traversal(V(), hasLabel('SOFTWARE'), group().by('lang').by(pipe(count())))),
  [{ java: 2 }],
); // TinkerPop expected 2; likely wrong

// fold / unfold
label('values(age).fold()', raw(traversal(V(), hasLabel('PERSON'), values('age'), fold())), [
  [29, 27, 32, 35],
]);
label(
  'fold().unfold() roundtrip',
  raw(traversal(V(), hasLabel('PERSON'), values('age'), fold(), unfold())),
  [29, 27, 32, 35],
);

// aggregate + cap
label('aggregate(x).cap(x)', res(traversal(V(), hasLabel('SOFTWARE'), aggregate('x'), cap('x'))), [
  ['lop', 'ripple'],
]);

// store vs aggregate (store is lazy/eager difference). Both collect here.
label('store(x).cap(x)', res(traversal(V(), hasLabel('SOFTWARE'), store('x'), cap('x'))), [
  ['lop', 'ripple'],
]);

// dedup global
label(
  'out(CREATED).dedupe().values(name)',
  res(traversal(V(), out('CREATED'), dedupe(), values('name'))).sort(),
  ['lop', 'ripple'],
);

// dedup(scope) with labels: dedup('a','b') keyed dedup
// order + range for sample-like
label(
  'order().by(age) asc',
  res(traversal(V(), hasLabel('PERSON'), order().by('age', Order.asc), values('name'))),
  ['vadas', 'marko', 'josh', 'peter'],
);
label(
  'order().by(age) desc',
  res(traversal(V(), hasLabel('PERSON'), order().by('age', Order.desc), values('name'))),
  ['peter', 'josh', 'marko', 'vadas'],
);

// order(Scope.local) -- KNOWN no-op per charter; record actual
label(
  'order(Scope.local) on folded list [known no-op]',
  raw(traversal(V(), hasLabel('PERSON'), values('age'), fold(), order(Scope.local))),
  [[27, 29, 32, 35]],
); // TinkerPop would sort; likely unsorted

// count/sum/min/max/mean global
label('values(age).count()', raw(traversal(V(), hasLabel('PERSON'), values('age'), count())), [4]);
label('values(age).sum()', raw(traversal(V(), hasLabel('PERSON'), values('age'), sum())), [123]);
label('values(age).min()', raw(traversal(V(), hasLabel('PERSON'), values('age'), min())), [27]);
label('values(age).max()', raw(traversal(V(), hasLabel('PERSON'), values('age'), max())), [35]);
label(
  'values(age).mean()',
  raw(traversal(V(), hasLabel('PERSON'), values('age'), mean())),
  [30.75],
);

// sample(2) - nondeterministic count check
label('sample(2) yields 2', raw(traversal(V(), hasLabel('PERSON'), sample(2))).length, 2);

// barrier() is a no-op passthrough for values
label(
  'barrier() passthrough count',
  raw(traversal(V(), hasLabel('PERSON'), barrier(), count())),
  [4],
);
