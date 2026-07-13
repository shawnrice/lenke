import { Graph } from '@lenke/core';
import {
  traversal,
  V,
  hasLabel,
  out,
  toArray,
  group,
  groupCount,
  count,
  sum,
  values,
  fold,
} from '@lenke/gremlin';
const g = new Graph();
const a = g.addVertex({ labels: ['U'], properties: { n: 'a' } });
const x = g.addVertex({ labels: ['I'], properties: { n: 'x' } });
const y = g.addVertex({ labels: ['I'], properties: { n: 'y' } });
g.addEdge({ from: a, to: x, labels: ['P'], properties: { w: 10 } });
g.addEdge({ from: a, to: x, labels: ['P'], properties: { w: 5 } }); // 2 edges to x
g.addEdge({ from: a, to: y, labels: ['P'], properties: { w: 3 } });
// group by item name, count edges -> expect {x:2, y:1}
console.log(
  'group.by(n).by(count()) [expect {x:2,y:1}]:',
  toArray(traversal(V(), hasLabel('U'), out('P'), group().by('n').by(count())), g),
);
// group by item name, sum of weights -> expect {x:15, y:3}
console.log(
  'group.by(n).by(sum via values(w)) [expect {x:15?,y:3}]:',
  toArray(
    traversal(
      V(),
      hasLabel('U'),
      out('P'),
      group()
        .by('n')
        .by(values('w').valueOf ? 'x' : 'x'),
    ),
    g,
  ),
);
