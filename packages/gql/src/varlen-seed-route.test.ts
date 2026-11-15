import { describe, expect, test } from 'bun:test';

import { compileLinear } from './executor/rewrites.js';
import { parse } from './parser.js';

/**
 * Which rung serves a SEEDED var-length count (item 1907).
 *
 * ⚠️⚠️ **THE ROUTE NEEDS ITS OWN ASSERTION BECAUSE CARRYING THE SEED GATE IS ANSWER-EQUIVALENT.**
 * Refusing a start predicate sends the query to the general path, which answers the same number more
 * slowly — so a mutant restoring item 583's refusal passed a 540-assertion cross-engine suite.
 * [[perf-gate-needs-its-own-test]], and the cost of the refusal was 129-138x.
 */
const rungFor = (text: string): string => {
  const stmt = parse(text);

  if (!('parts' in stmt)) {
    throw new Error('not a linear statement');
  }

  const lin = compileLinear(stmt.parts[0]) as Record<string, unknown> | undefined;

  if (lin === undefined) {
    return 'GENERAL';
  }

  const willing = Object.entries(lin)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'clauses' && k !== 'writes')
    .map(([k]) => k);

  return willing.length === 0 ? 'GENERAL' : willing[0];
};

describe('a seeded var-length count reaches the rung in every spelling', () => {
  /** ⚠️ ALL THREE, because item 583 refused the gate precisely to keep them from splitting. */
  const CLAIMED = [
    'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p RETURN count(*) AS c',
    'MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) RETURN count(*) AS c',
    'MATCH (a:T WHERE a.n = $p)-[:E]->{1,3}(b:T) RETURN count(*) AS c',
    // The per-source arm (`max <= 1`) as well as the level one.
    'MATCH (a:T)-[:E]->{0,1}(b:T) WHERE a.n = $p RETURN count(*) AS c',
    // Both ends constrained, each from a different spelling.
    'MATCH (a:T {n: $p})-[:E]->{1,3}(b:T) WHERE b.n = $q RETURN count(*) AS c',
    // The mirror direction (item 744's axis).
    'MATCH (a:T)<-[:E]-{1,3}(b:T) WHERE a.n = $p RETURN count(*) AS c',
  ] as const;

  for (const q of CLAIMED) {
    test(`routes ${q}`, () => {
      expect(rungFor(q)).toBe('varLengthCount');
    });
  }

  /** ⚠️ A predicate reading BOTH ends is not a seed test and must still decline. */
  test('a predicate spanning both ends still declines', () => {
    expect(rungFor('MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = b.n RETURN count(*) AS c')).toBe(
      'GENERAL',
    );
  });
});
