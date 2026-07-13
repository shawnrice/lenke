import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  hasLabel,
  out,
  values,
  toArray,
  groupCount,
  group,
  order,
  Order,
  count,
} from '@lenke/gremlin';

const g = new Graph();
const a = g.addVertex({ labels: ['User'], properties: { name: 'a' } });
const b = g.addVertex({ labels: ['User'], properties: { name: 'b' } });
const x = g.addVertex({ labels: ['Item'], properties: { name: 'x' } });
const y = g.addVertex({ labels: ['Item'], properties: { name: 'y' } });
g.addEdge({ from: a, to: x, labels: ['PURCHASED'], properties: { w: 1 } });
g.addEdge({ from: b, to: x, labels: ['PURCHASED'], properties: { w: 2 } });
g.addEdge({ from: a, to: y, labels: ['PURCHASED'], properties: { w: 3 } });

console.log(
  'groupCount by name:',
  toArray(traversal(V(), hasLabel('User'), out('PURCHASED'), groupCount().by('name')), g),
);
console.log(
  'group by name -> count:',
  toArray(traversal(V(), hasLabel('User'), out('PURCHASED'), group().by('name').by(count())), g),
);
console.log(
  'order desc:',
  toArray(
    traversal(V(), hasLabel('User'), out('PURCHASED'), values('name'), order().by(Order.desc)),
    g,
  ),
);
