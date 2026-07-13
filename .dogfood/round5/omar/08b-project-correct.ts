import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  hasLabel,
  toArray,
  project,
  values,
  pipe,
  order,
  Order,
} from '@lenke/gremlin';
const g = new Graph();
g.addVertex({ labels: ['I'], properties: { n: 'x', price: 5 } });
g.addVertex({ labels: ['I'], properties: { n: 'y', price: 9 } });

// correct array form
console.log(
  'project([keys]).by.by:',
  toArray(traversal(V(), hasLabel('I'), project(['name', 'price']).by('n').by('price')), g),
);

// order a projected map list? sort items by price desc using project then... can't order maps.
console.log(
  'project value:',
  toArray(
    traversal(
      V(),
      hasLabel('I'),
      project(['name', 'price'])
        .by(pipe(values('n')))
        .by(pipe(values('price'))),
    ),
    g,
  ),
);
