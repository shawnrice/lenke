import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { run, toArray, traversal, V, out, values, has } from '@lenke/gremlin';

const g = new Graph();
const a = g.addVertex({ labels: ['N'], properties: { name: 'a' } });
const b = g.addVertex({ labels: ['N'], properties: { name: 'b' } });
g.addEdge({ from: a, to: b, labels: ['E'], properties: { w: 2 } });
console.log('gremlin:', toArray(traversal(V(), has('name', 'a'), out('E'), values('name')), g));
console.log('gql:', query(g, `MATCH (a:N {name:'a'})-[:E]->(b) RETURN b.name AS n`));
