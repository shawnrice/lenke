import {
  traversal,
  V,
  has,
  out,
  values,
  repeat,
  loops,
  is,
  eq,
  gt,
  gte,
  lt,
  pipe,
  path,
} from '@lenke/gremlin';

import { res, label } from './util.ts';

console.log('\n===== LOOPS() SEMANTICS =====');
// From marko: 1-hop frontier = {vadas,josh,lop}; 2-hop = {ripple,lop}
const M = (steps: any[]) =>
  res(traversal(V(), has('name', 'marko'), ...steps, values('name'))).sort();

// post-until: repeat(out()).until(loops == N)
label('until(loops().is(eq(1)))', M([repeat(out()).until(pipe(loops(), is(eq(1))))]), null);
label('until(loops().is(eq(2)))', M([repeat(out()).until(pipe(loops(), is(eq(2))))]), null);
label('until(loops().is(gt(0)))', M([repeat(out()).until(pipe(loops(), is(gt(0))))]), null);
label('until(loops().is(gt(1)))', M([repeat(out()).until(pipe(loops(), is(gt(1))))]), null);

// times equivalents for reference
label('repeat(out).times(1)', M([repeat(out()).times(1)]), null);
label('repeat(out).times(2)', M([repeat(out()).times(2)]), null);

// emit-after with loops predicate
label(
  'repeat(out).times(3).emit(loops==1)',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      repeat(out())
        .times(3)
        .emit(pipe(loops(), is(eq(1)))),
      values('name'),
    ),
  ).sort(),
  null,
);
label(
  'repeat(out).times(3).emit(loops==2)',
  res(
    traversal(
      V(),
      has('name', 'marko'),
      repeat(out())
        .times(3)
        .emit(pipe(loops(), is(eq(2)))),
      values('name'),
    ),
  ).sort(),
  null,
);
