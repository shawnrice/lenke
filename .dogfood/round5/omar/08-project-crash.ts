import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  hasLabel,
  out,
  toArray,
  project,
  values,
  pipe,
  limit,
  tail,
  Scope,
  count,
  select,
} from '@lenke/gremlin';
const g = new Graph();
const a = g.addVertex({ labels: ['U'], properties: { n: 'a' } });
const x = g.addVertex({ labels: ['I'], properties: { n: 'x', price: 5 } });
g.addEdge({ from: a, to: x, labels: ['P'], properties: {} });

function tryIt(label: string, fn: () => unknown) {
  try {
    console.log(label, '=>', fn());
  } catch (e: any) {
    console.log(label, 'ERR', e.constructor?.name, e.code ?? '', e.message);
  }
}

// project with simple string bys (should work)
tryIt('project.by(str).by(str)', () =>
  toArray(traversal(V(), hasLabel('I'), project('name', 'price').by('n').by('price')), g),
);

// project with a pipe() sub-plan by  <-- suspect
tryIt('project.by(pipe(values))', () =>
  toArray(traversal(V(), hasLabel('I'), project('name').by(pipe(values('n')))), g),
);

// project with a pipe containing a Scope-local step
tryIt('project.by(pipe(limit local))', () =>
  toArray(traversal(V(), hasLabel('U'), out('P'), project('x').by(pipe(limit(Scope.local, 1)))), g),
);

// order by a pipe sub-plan
tryIt('order.by(pipe(values))', () =>
  toArray(
    traversal(V(), hasLabel('I'), values('n'), () => ({ steps: [] }) as any),
    g,
  ),
);
