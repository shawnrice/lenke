import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
g.addVertex({ labels: ['P'], properties: { x: 3 } });
console.log(JSON.stringify(query(g, 'MATCH (n:P) RETURN n.x + 1 AS y')));
