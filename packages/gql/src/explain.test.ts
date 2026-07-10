import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { explain } from './explain.js';

describe('gql explain (logical, no graph)', () => {
  test('summarizes a MATCH/WHERE/RETURN with aggregation, distinct, and limit', () => {
    const out = explain(
      `MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 30
       RETURN DISTINCT b.name, count(*) AS n ORDER BY b.name LIMIT 5`,
    );

    expect(out).toContain('Query — 1 part');
    expect(out).toContain('MATCH');
    expect(out).toContain('1 pattern(s), 3 elements'); // 1 node + 1 segment × 2
    expect(out).toContain('WHERE');
    expect(out).toContain('RETURN');
    expect(out).toContain('distinct');
    expect(out).toContain('aggregating');
    expect(out).toContain('limit 5');
  });

  test('shows set operations between parts', () => {
    const out = explain('MATCH (a:Person) RETURN a.name UNION MATCH (s:Software) RETURN s.name');

    expect(out).toContain('Query — 2 parts');
    expect(out).toContain('UNION');
  });

  test('accepts an already-parsed Query', () => {
    // A string round-trips through parse(); a pre-parsed AST is also accepted.
    expect(explain('MATCH (n) RETURN n')).toContain('MATCH');
  });
});

describe('gql explain (physical, with a graph)', () => {
  const people = (): Graph => {
    const g = new Graph();

    for (let i = 0; i < 100; i++) {
      g.addVertex({ labels: ['Person'], properties: { name: `p${i}`, age: 20 + (i % 40) } });
    }

    return g;
  };

  test('a clause WHERE with no index → label scan of the whole label', () => {
    const out = explain(`MATCH (a:Person) WHERE a.age > 55 RETURN a`, people());

    expect(out).toContain('seed a');
    expect(out).toContain('label scan :Person');
    expect(out).toContain('100 vertices');
  });

  test('the same query WITH an index → an index seek and a smaller estimate', () => {
    const g = people();
    g.createVertexIndex('age');

    const out = explain(`MATCH (a:Person) WHERE a.age > 55 RETURN a`, g);

    expect(out).toContain('index seek age (range)');
    expect(out).not.toContain('label scan');
    // the estimate reflects the seek, not the full label
    expect(out).not.toContain('~100 vertices');
  });

  test('an indexed equality shows the value and a tight estimate', () => {
    const g = people();
    g.createVertexIndex('name');

    const out = explain(`MATCH (a:Person) WHERE a.name = 'p7' RETURN a`, g);

    expect(out).toContain("index seek name = 'p7'");
    expect(out).toContain('~1 vertices');
  });

  test('renders the expansion of a multi-hop pattern', () => {
    const out = explain(`MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN b`, people());

    expect(out).toContain('expand -[:KNOWS]->');
  });
});
