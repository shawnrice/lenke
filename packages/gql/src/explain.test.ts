import { describe, expect, test } from 'bun:test';

import { explain } from './explain.js';

describe('gql explain', () => {
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
