import { describe, expect, test } from 'bun:test';

import { createTestSocialGraph } from './fixtures/createTestSocialGraph.js';
import { query } from './index.js';

const sorted = (rows: { [k: string]: unknown }[], col: string): unknown[] =>
  rows.map((r) => r[col]).sort();

describe('GQL property-index seeding', () => {
  test('an equality property constraint returns the same rows whether or not name is indexed', () => {
    const plain = createTestSocialGraph();
    const indexed = createTestSocialGraph();
    indexed.createVertexIndex('name');

    const q = `MATCH (p:Person {name: 'marko'})-[:KNOWS]->(b) RETURN b.name`;
    expect(sorted(query(indexed, q), 'b.name')).toEqual(sorted(query(plain, q), 'b.name'));
    expect(sorted(query(indexed, q), 'b.name')).toEqual(['josh', 'vadas']);
  });

  test('the label constraint still excludes a same-named wrong-label vertex', () => {
    const g = createTestSocialGraph();
    g.createVertexIndex('name');
    // lop is Software; seeding from the name bucket must still honor :Person.
    expect(query(g, `MATCH (p:Person {name: 'lop'}) RETURN p.name`)).toEqual([]);
    expect(query(g, `MATCH (s:Software {name: 'lop'}) RETURN s.name`)).toEqual([
      { 's.name': 'lop' },
    ]);
  });

  test('a non-indexed key still works via the scan fallback', () => {
    const g = createTestSocialGraph();
    g.createVertexIndex('name'); // age is NOT indexed
    const rows = query(g, `MATCH (p:Person {age: 32}) RETURN p.name`);
    expect(sorted(rows, 'p.name')).toEqual(['josh']);
  });

  test('seeding reflects live mutations', () => {
    const g = createTestSocialGraph();
    g.createVertexIndex('name');
    g.addVertex({ id: '99', labels: ['Person'], properties: { name: 'marko', age: 50 } });
    const rows = query(g, `MATCH (p:Person {name: 'marko'}) RETURN p.age`);
    expect(sorted(rows, 'p.age')).toEqual([29, 50]);
  });

  test('an empty bucket yields no rows', () => {
    const g = createTestSocialGraph();
    g.createVertexIndex('name');
    expect(query(g, `MATCH (p:Person {name: 'nobody'}) RETURN p.name`)).toEqual([]);
  });
});
