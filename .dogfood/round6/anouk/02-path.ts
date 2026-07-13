import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  in_,
  both,
  values,
  path,
  simplePath,
  cyclicPath,
  tree,
  repeat,
  times,
  until,
  emit,
  count,
  dedupe,
  shortestPath,
  ShortestPath,
  as_,
  select,
  loops,
  is,
  gt,
  pipe,
  local,
  by,
} from '@lenke/gremlin';

import { res, raw, label, g } from './util.ts';

console.log('\n===== PATH =====');

// path(): marko -> created -> lop, full path
label(
  'path() marko out CREATED values(name)',
  res(traversal(V(), has('name', 'marko'), out('CREATED'), path())),
  [['marko', 'lop']],
); // path elements shown by name

// path with by(name)
label(
  'path().by(name)',
  res(traversal(V(), has('name', 'marko'), out('KNOWS'), path().by('name'))),
  [
    ['marko', 'vadas'],
    ['marko', 'josh'],
  ],
);

// repeat().times(2): marko 2 hops out
label(
  'repeat(out).times(2) from marko values(name)',
  res(traversal(V(), has('name', 'marko'), repeat(out()).times(2), values('name'))),
  ['ripple', 'lop'],
); // marko->josh->{ripple,lop}; marko->vadas(dead end); marko->lop(dead end)

// repeat emit (post-form): emit every hop after body
label(
  'repeat(out).times(2).emit() names',
  res(traversal(V(), has('name', 'marko'), repeat(out()).times(2).emit(), values('name'))),
  ['vadas', 'josh', 'lop', 'ripple', 'lop'],
); // level1: vadas,josh,lop; level2 from josh: ripple,lop

// repeat until name=ripple
label(
  'repeat(out).until(has name ripple) from marko',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      repeat(out()).until(has('name', 'ripple')),
      values('name'),
    ),
  ),
  ['ripple'],
);

// simplePath: 2-hop paths with no repeated vertex
label(
  'repeat(out).times(2).simplePath count',
  raw(traversal(V(), repeat(out()).times(2), simplePath(), count())),
  [2],
); // marko->josh->ripple, marko->josh->lop (both simple)

// tree
label(
  'tree() marko out out',
  raw(traversal(V(), has('name', 'marko'), out(), out(), tree())).length,
  1,
);

// shortestPath from marko to ripple
label(
  'shortestPath marko->ripple',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      shortestPath().with(ShortestPath.target, has('name', 'ripple')),
    ),
  ),
  [['marko', 'josh', 'ripple']],
);

// loops() usage in until
label(
  'repeat(out).until(loops==2) from marko',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      repeat(out()).until(pipe(loops(), is(gt(1)))),
      values('name'),
    ),
  ).sort(),
  ['lop', 'ripple'],
);

// cyclicPath: modern graph is a DAG, so no cycles reachable
label(
  'cyclicPath in DAG -> empty',
  res(traversal(V(), repeat(out()).times(3), cyclicPath(), path())),
  [],
);
