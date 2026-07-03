import { test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from '../packages/gql/src/index.js';
import { ndjsonCodec } from '../packages/serialization/src/index.js';

test('smoke: TS gql accepts the benchmark query shapes', () => {
  const nd = [
    JSON.stringify({
      type: 'node',
      id: 'a',
      labels: ['Person'],
      properties: { name: 'ann', age: 30, active: true },
    }),
    JSON.stringify({
      type: 'node',
      id: 'b',
      labels: ['Person'],
      properties: { name: 'bo', age: 60, active: false },
    }),
    JSON.stringify({
      type: 'node',
      id: 'c',
      labels: ['Person'],
      properties: { name: 'cy', age: 70, active: true },
    }),
    JSON.stringify({
      type: 'edge',
      id: 'e0',
      from: 'a',
      to: 'b',
      labels: ['KNOWS'],
      properties: {},
    }),
    JSON.stringify({
      type: 'edge',
      id: 'e1',
      from: 'b',
      to: 'c',
      labels: ['KNOWS'],
      properties: {},
    }),
  ].join('\n');
  const g = ndjsonCodec.decode(nd, new Graph());
  console.log('Q1', JSON.stringify(query(g, 'MATCH (a:Person) RETURN count(*)')));
  console.log('Q2', JSON.stringify(query(g, 'MATCH (a:Person) WHERE a.age > 50 RETURN a.age')));
  console.log(
    'Q3',
    JSON.stringify(query(g, 'MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN count(*)')),
  );
  console.log(
    'Q4',
    JSON.stringify(
      query(g, 'MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) RETURN count(*)'),
    ),
  );
});
