import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  has,
  hasLabel,
  out,
  in_,
  both,
  values,
  count,
  repeat,
  emit,
  path,
  cyclicPath,
  simplePath,
  dedupe,
  by,
  as_,
  select,
  sideEffect,
  aggregate,
  cap,
  subgraph,
  inE,
  outE,
  local,
  fold,
  order,
  Order,
  Scope,
  constant,
  choose,
  pipe,
  project,
  groupCount,
  label as labelStep,
} from '@lenke/gremlin';
import { toArray } from '@lenke/gremlin';

import { res, raw, label, createTestTinkerGraph } from './util.ts';

console.log('\n===== EMIT PRE-FORM ZERO-HOP (V1 fix) =====');
// emitBefore includes level-0 start
label(
  'repeat(out).times(2).emitBefore() from marko',
  res(
    traversal(V(), has('name', 'marko'), repeat(out()).times(2).emitBefore(), values('name')),
  ).sort(),
  ['josh', 'lop', 'lop', 'marko', 'ripple', 'vadas'],
);

console.log('\n===== CYCLIC PATH (real cycle) =====');
{
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['N'], properties: { name: 'a' } });
  const b = g.addVertex({ id: 'b', labels: ['N'], properties: { name: 'b' } });
  const c = g.addVertex({ id: 'c', labels: ['N'], properties: { name: 'c' } });
  g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ from: b, to: c, labels: ['E'], properties: {} });
  g.addEdge({ from: c, to: a, labels: ['E'], properties: {} });
  label(
    'cyclicPath: repeat(out).until(cyclicPath).path from a',
    res(traversal(V(), has('name', 'a'), repeat(out()).until(cyclicPath()), path()), g),
    [['a', 'b', 'c', 'a']],
  );
}

console.log('\n===== DEDUP scope/by =====');
label(
  'dedupe().by(lang) on software',
  res(traversal(V(), hasLabel('SOFTWARE'), dedupe().by('lang'), values('name'))).length,
  1,
);
// dedup by out-degree grouping persons
label(
  'persons dedupe().by(out().count())',
  res(traversal(V(), hasLabel('PERSON'), dedupe().by(pipe(out(), count())), values('name'))).length,
  4,
); // out-degrees: marko3 vadas0 josh2 peter1 -> all distinct -> 4

console.log('\n===== SIDE EFFECT =====');
{
  const g = createTestTinkerGraph();
  const seen: string[] = [];
  const r = res(
    traversal(
      V(),
      hasLabel('SOFTWARE'),
      sideEffect((t: any) => {
        seen.push('x');
      }),
      values('name'),
    ),
    g,
  );
  label('sideEffect(fn) passthrough', r.sort(), ['lop', 'ripple']);
  label('sideEffect fired per element', seen.length, 2);
}

console.log('\n===== SUBGRAPH / CAP =====');
{
  const g = createTestTinkerGraph();
  const r = raw(traversal(V(), has('name', 'marko'), outE('KNOWS'), subgraph('sg'), cap('sg')), g);
  const sub = r[0] as Graph;
  const edgeCount =
    sub instanceof Graph
      ? (toArray(traversal(V(), outE()), sub) as unknown[]).length
      : 'not-a-graph';
  label('subgraph(sg) captured 2 KNOWS edges', edgeCount, 2);
}

console.log('\n===== SACK (expected absent) =====');
try {
  const mod: any = await import('@lenke/gremlin');
  label('sack export present?', typeof mod.sack, 'undefined');
  label('withSack export present?', typeof mod.withSack, 'undefined');
} catch (e: any) {
  console.log('import err', e.message);
}

console.log('\n===== CHOOSE option-map (expected missing) =====');
{
  const mod: any = await import('@lenke/gremlin');
  try {
    const ch = mod.choose(pipe(values('lang')));
    label('choose(test-only).option is a function?', typeof ch?.option, 'function(if supported)');
  } catch (e: any) {
    label(
      'choose(test-only) [1-arg option-map] throws -> option-map MISSING',
      e.message,
      undefined,
    );
  }
}
