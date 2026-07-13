import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  hasLabel,
  outE,
  inV,
  toArray,
  group,
  count,
  sum,
  values,
  pipe,
} from '@lenke/gremlin';
const g = new Graph();
const a = g.addVertex({ labels: ['U'], properties: { n: 'a' } });
const x = g.addVertex({ labels: ['I'], properties: { n: 'x' } });
const y = g.addVertex({ labels: ['I'], properties: { n: 'y' } });
g.addEdge({ from: a, to: x, labels: ['P'], properties: { w: 10 } });
g.addEdge({ from: a, to: x, labels: ['P'], properties: { w: 5 } });
g.addEdge({ from: a, to: y, labels: ['P'], properties: { w: 3 } });

// count edges per item; expect {x:2, y:1}
console.log(
  'count reducer [expect {x:2,y:1}]:',
  toArray(
    traversal(
      V(),
      hasLabel('U'),
      outE('P'),
      group()
        .by(pipe(inV(), values('n')))
        .by(count()),
    ),
    g,
  ),
);

// sum of edge weights per item; expect {x:15, y:3}
console.log(
  'sum reducer  [expect {x:15,y:3}]:',
  toArray(
    traversal(
      V(),
      hasLabel('U'),
      outE('P'),
      group()
        .by(pipe(inV(), values('n')))
        .by(pipe(values('w'), sum())),
    ),
    g,
  ),
);
