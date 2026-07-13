import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const a = g.addVertex({ labels: ['P'], properties: { name: 'a' } });
const b = g.addVertex({ labels: ['P'], properties: { name: 'b' } });
g.addEdge({ from: a, to: b, labels: ['E'] });
g.addEdge({ from: b, to: a, labels: ['E'] }); // 2-cycle a<->b, two distinct edges
// walk a->b->a revisits NODE a but uses 2 DISTINCT edges.
console.log(
  'a-[:E]->{2}(a):',
  query(g, `MATCH (a:P {name:'a'})-[:E]->{2}(x:P {name:'a'}) RETURN count(*) AS c`)[0],
);
// a->b->a->b revisits node & edge? a->b(e1)->a(e2)->b(e1 again) repeats edge e1
console.log(
  'a-[:E]->{3}(b):',
  query(g, `MATCH (a:P {name:'a'})-[:E]->{3}(x:P {name:'b'}) RETURN count(*) AS c`)[0],
);
console.log(
  'a-[:E]->{1}(b):',
  query(g, `MATCH (a:P {name:'a'})-[:E]->{1}(x:P {name:'b'}) RETURN count(*) AS c`)[0],
);
