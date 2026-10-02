import { beforeEach, describe, expect, test } from 'bun:test';

import {
  accept,
  classify,
  type DivergenceCase,
  resetUsage,
  unused,
  usageCounts,
  REGISTRY,
} from './divergence-registry.js';

// A registry whose entries are never tested is a registry that excuses whatever it happens to
// match. These prove the two properties that keep it honest: a VALUE divergence is refused
// however the list is written, and an entry only covers the shape it actually pins.

const ok = (json: string): DivergenceCase['ts'] => ({ ok: true, json });
const err = (code: string): DivergenceCase['ts'] => ({ ok: false, code });

const c = (ts: DivergenceCase['ts'], native: DivergenceCase['ts']): DivergenceCase => ({
  query: 'MATCH (n) RETURN n',
  ts,
  native,
});

describe('classify names the KIND of difference', () => {
  test('two different answers are a value difference', () => {
    expect(classify(c(ok('[{"x":1}]'), ok('[{"x":2}]')))).toBe('value');
  });

  test('the same rows in a different order is an ordering difference', () => {
    expect(classify(c(ok('[{"x":1},{"x":2}]'), ok('[{"x":2},{"x":1}]')))).toBe('order');
  });

  test('a different number of the same row is NOT an ordering difference', () => {
    // A multiset comparison has to count duplicates, or a wrong cardinality passes as a
    // reorder — which is a wrong answer.
    expect(classify(c(ok('[{"x":1},{"x":1}]'), ok('[{"x":1}]')))).toBe('value');
  });

  test('a last-places numeric difference is a float-reduction difference', () => {
    expect(classify(c(ok('[{"s":0.30000000000000004}]'), ok('[{"s":0.3}]')))).toBe(
      'float-reduction',
    );
  });

  test('a numeric difference beyond the tolerance is a value difference', () => {
    expect(classify(c(ok('[{"s":1.5}]'), ok('[{"s":1.6}]')))).toBe('value');
  });

  test('one side exhausting a limit is a resource difference', () => {
    expect(classify(c(err('E_RESOURCE_EXHAUSTED'), ok('[{"c":1}]')))).toBe('resource');
    expect(classify(c(ok('[{"c":1}]'), err('E_RESOURCE_EXHAUSTED')))).toBe('resource');
  });

  test('a one-sided non-resource error is an evaluation-order difference', () => {
    expect(classify(c(err('E_INVALID_VALUE'), ok('[]')))).toBe('evaluation-order');
  });

  test('two different error codes is a value difference, not a capability one', () => {
    expect(classify(c(err('E_INVALID_VALUE'), err('E_TYPE_MISMATCH')))).toBe('value');
  });
});

describe('accept refuses what no entry may excuse', () => {
  beforeEach(resetUsage);

  test('a value divergence is refused even though an entry would match its shape', () => {
    // Same shape as the declared boolean residual on one side, but the permissive side
    // returned ROWS rather than nothing — so the engines disagree about an answer.
    const v = accept(c(err('E_INVALID_VALUE'), ok('[{"x":5}]')));

    expect(v.accepted).toBe(false);
    expect(!v.accepted && v.observed).toBe('evaluation-order');
  });

  test('the CALL-body laziness bug is NOT covered by the boolean residual entry', () => {
    // The real shape, from FUZZ_SEED=3583567550: TS raises, native answers four rows. This is
    // the regression test for the registry itself — if a future entry starts matching this,
    // a laziness bug has been declared as a capability difference.
    const v = accept({
      query:
        "MATCH (n:T) CALL (n) { MATCH (n WHERE ((n.n % n.x) <> [9007199254740992, '\\n0']))-[:E]->(m) RETURN m.n AS mn } RETURN mn AS x ORDER BY x",
      ts: err('E_INVALID_VALUE'),
      native: ok('[{"x":5},{"x":5},{"x":7},{"x":11}]'),
    });

    expect(v.accepted).toBe(false);
  });

  test('a plain wrong answer is refused', () => {
    const v = accept(c(ok('[{"x":1}]'), ok('[{"x":2}]')));

    expect(v.accepted).toBe(false);
    expect(!v.accepted && v.observed).toBe('value');
    expect(!v.accepted && v.why).toContain('no registry entry may excuse');
  });
});

describe('the declared boolean-context residual', () => {
  beforeEach(resetUsage);

  test('is accepted in both directions, against an EMPTY result', () => {
    const tsRaised = accept(c(err('E_INVALID_VALUE'), ok('[]')));
    expect(tsRaised.accepted).toBe(true);
    expect(tsRaised.accepted && tsRaised.by).toBe('boolean-context-dynamic-operand-under-seek');

    const nativeRaised = accept(c(ok('[]'), err('E_INVALID_VALUE')));
    expect(nativeRaised.accepted).toBe(true);
  });

  test('does not cover a different error code', () => {
    expect(accept(c(err('E_TYPE_MISMATCH'), ok('[]'))).accepted).toBe(false);
  });

  test('does not cover a resource difference', () => {
    expect(accept(c(err('E_RESOURCE_EXHAUSTED'), ok('[]'))).accepted).toBe(false);
  });

  test('records its usage, so an entry that stops matching can be found', () => {
    expect(usageCounts().get('boolean-context-dynamic-operand-under-seek') ?? 0).toBe(0);
    accept(c(err('E_INVALID_VALUE'), ok('[]')));
    accept(c(ok('[]'), err('E_INVALID_VALUE')));
    expect(usageCounts().get('boolean-context-dynamic-operand-under-seek')).toBe(2);
  });
});

describe('the registry cannot rot unnoticed', () => {
  beforeEach(resetUsage);

  test('unused reports an entry nothing exercised', () => {
    expect(unused(false)).toContain('boolean-context-dynamic-operand-under-seek');
    accept(c(err('E_INVALID_VALUE'), ok('[]')));
    expect(unused(false)).not.toContain('boolean-context-dynamic-operand-under-seek');
  });

  test('every entry carries the reasoning a human needs to audit it', () => {
    for (const e of REGISTRY) {
      expect(e.id, 'an id').toMatch(/^[a-z0-9-]+$/);
      expect(e.reason.length, `${e.id} states why this is not a bug`).toBeGreaterThan(80);
      expect(e.recorded.length, `${e.id} points at where it was decided`).toBeGreaterThan(10);
    }
  });

  test('no entry claims the value axis', () => {
    // `Axis` excludes it at the type level; this is the runtime twin, so a cast or a JSON
    // round-trip cannot sneak one in.
    for (const e of REGISTRY) {
      expect(['resource', 'evaluation-order', 'order', 'float-reduction']).toContain(e.axis);
    }
  });
});
