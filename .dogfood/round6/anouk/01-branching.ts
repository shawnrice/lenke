import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  in_,
  outE,
  values,
  count,
  choose,
  coalesce,
  optional,
  union,
  local,
  where,
  not,
  and,
  or,
  is,
  gt,
  gte,
  lt,
  constant,
  fold,
  pipe,
  hasNot,
  within,
  select,
  as_,
  label as labelStep,
  project,
} from '@lenke/gremlin';

import { res, label, g } from './util.ts';

console.log('\n===== BRANCHING / LOGIC =====');

// choose(pred, true, false): persons age>30 -> "old" else "young"
// TinkerPop: g.V().hasLabel(PERSON).choose(has(age,gt(30)), constant('old'), constant('young'))
label(
  'choose(pred, t, f) on persons',
  res(
    traversal(
      V(),
      hasLabel('PERSON'),
      choose(has('age', gt(30)), constant('old'), constant('young')),
    ),
  ),
  ['young', 'young', 'old', 'old'],
); // marko29 vadas27 josh32 peter35

// choose with traversal predicate producing option map is more complex; test 2-branch form only.

// coalesce: out(KNOWS) else out(CREATED) — marko has KNOWS so returns knows targets
label(
  'coalesce(out KNOWS, out CREATED) from marko',
  res(traversal(V(), has('name', 'marko'), coalesce(out('KNOWS'), out('CREATED')), values('name'))),
  ['vadas', 'josh'],
);
// lop has no out -> coalesce falls to CREATED (also none) -> constant fallback
label(
  'coalesce fallback to constant for lop (no out)',
  res(traversal(V(), has('name', 'lop'), coalesce(out('KNOWS'), constant('none')))),
  ['none'],
);

// optional: out(CREATED) if present else self
label(
  'optional(out CREATED) from marko -> lop',
  res(traversal(V(), has('name', 'marko'), optional(out('CREATED')), values('name'))),
  ['lop'],
);
label(
  'optional(out CREATED) from vadas -> self (vadas has none)',
  res(traversal(V(), has('name', 'vadas'), optional(out('CREATED')), values('name'))),
  ['vadas'],
);

// union: names of out KNOWS and out CREATED from marko
label(
  'union(out KNOWS, out CREATED) from marko',
  res(traversal(V(), has('name', 'marko'), union(out('KNOWS'), out('CREATED')), values('name'))),
  ['vadas', 'josh', 'lop'],
);

// local: cap per-element. local(out().count()) => per-vertex out-degree
label(
  'local(out().count()) per person',
  res(traversal(V(), hasLabel('PERSON'), local(pipe(out(), count())))),
  [3, 0, 2, 1],
); // marko3 vadas0 josh2 peter1

// where(traversal): persons who created something
label(
  'where(out CREATED) persons',
  res(traversal(V(), hasLabel('PERSON'), where(out('CREATED')), values('name'))),
  ['marko', 'josh', 'peter'],
);

// not(out CREATED): persons who did NOT create
label(
  'not(out CREATED) persons',
  res(traversal(V(), hasLabel('PERSON'), not(out('CREATED')), values('name'))),
  ['vadas'],
);

// and(out KNOWS, out CREATED): persons with both
label(
  'and(out KNOWS, out CREATED)',
  res(traversal(V(), hasLabel('PERSON'), and(out('KNOWS'), out('CREATED')), values('name'))),
  ['marko'],
);

// or(out KNOWS, out CREATED): persons with either
label(
  'or(out KNOWS, out CREATED)',
  res(traversal(V(), hasLabel('PERSON'), or(out('KNOWS'), out('CREATED')), values('name'))),
  ['marko', 'josh', 'peter'],
);

// is + count
label(
  'is(gt) on count: persons with >1 out',
  res(traversal(V(), hasLabel('PERSON'), where(pipe(out(), count(), is(gt(1)))), values('name'))),
  ['marko', 'josh'],
);
