import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

// `NOT (n.m.k = 5)` is `n.m.k <> 5`, and the DOTTED form now lifts by flipping the operator into
// `pathProps` (item 1290). Item 1272 added the flip for FLAT compares and recorded the dotted one
// as still declining; `asPropCompare` matches a plain `prop` only, so the negation of a dotted
// compare took the whole chain to the generic evaluator while the `<>` spelling of the same
// question lifted.
//
// Priced against the DOTTED POSITIVE form, which is the right twin: item 899 measured the dotted
// field step at 101.5 ns/row against a flat 26.5, so comparing to a flat spelling would price the
// field walk and call it a missing arm. 200,000 vertices, one shape per process, min of three
// alternated rounds, both answering an identical 198000:
//
//     n.m.k <> 5           10.18 ms -> 10.98    flat (the twin, and the control)
//     NOT (n.m.k = 5)      19.84    -> 10.06    1.97x, landing ON that twin
//     [CTL] NOT (n.a = 5)   4.80    ->  4.29    flat, flat form lifted since item 1272
//     [CTL] n.m.k = 5      10.68    -> 10.88    flat, dotted equality lifted since item 900
//
// ⚠️ EQUALITY ONLY, AND THE RESTRICTION IS NaN — the same hole item 1272 demonstrated for the flat
// form. `NOT (x >= 2)` is NOT `x < 2`, because every ordering comparison against NaN is FALSE here,
// so the negation is TRUE where the flip is FALSE. The ordering assertions below are what fail if
// `NEGATED_COMPARE` is ever widened.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'k1', labels: ['P'], properties: { nm: 'k1', m: { k: 1 } } });
  g.addVertex({ id: 'k5', labels: ['P'], properties: { nm: 'k5', m: { k: 5 } } });
  g.addVertex({ id: 'k9', labels: ['P'], properties: { nm: 'k9', m: { k: 9 } } });
  // A record present but the SEGMENT missing, and the record itself missing: both make the dotted
  // read UNKNOWN, so they drop under every spelling here.
  g.addVertex({ id: 'nok', labels: ['P'], properties: { nm: 'nok', m: { other: 1 } } });
  g.addVertex({ id: 'nom', labels: ['P'], properties: { nm: 'nom' } });

  return g;
};

const g = build();
const ids = (where: string): string[] =>
  query(g, `MATCH (n:P) WHERE ${where} RETURN n.nm AS nm`)
    .map((r) => String(r.nm))
    .sort();

describe('a DOTTED negated compare lifts by flipping the operator (item 1290)', () => {
  test('⚠️ ROUTE: the flip lands in pathProps, and an ORDERING operator does NOT lift', () => {
    const lifted = (src: string) => compilePredicate(undefined, parsePredicate(src), 'n');

    // `NOT (n.m.k = 5)` becomes `n.m.k <> 5`, which is not an equality, so it lands in `pathProps`
    // carrying the flipped operator.
    const notEq = lifted('NOT (n.m.k = 5)');

    expect((notEq.pathProps ?? []).length).toBe(1);
    expect(notEq.pathProps?.[0].op).toBe('<>');
    expect(notEq.where).toBeUndefined();
    expect(hasPredicate(notEq)).toBe(true);

    // `NOT (n.m.k <> 5)` becomes `n.m.k = 5`, also a path compare — `pathProps` carries its own
    // operator, so an equality does not move to `eqProps` the way the FLAT form's does.
    const notNe = lifted('NOT (n.m.k <> 5)');

    expect((notNe.pathProps ?? []).length).toBe(1);
    expect(notNe.pathProps?.[0].op).toBe('=');
    expect(notNe.where).toBeUndefined();

    // ⚠️ EVERY ORDERING OPERATOR STAYS ON THE GENERIC PATH. This is the assertion that fails if the
    // flip table is widened, and `negated-compare-lift.test.ts` demonstrates what that costs with a
    // NaN param — which is not coerced the way a stored NaN is, so the divergence is reachable.
    for (const op of ['>', '>=', '<', '<=']) {
      const notOrd = lifted(`NOT (n.m.k ${op} 5)`);

      expect(notOrd.pathProps).toBeUndefined();
      expect(notOrd.eqProps).toBeUndefined();
      expect(notOrd.cmpProps).toBeUndefined();
      expect(notOrd.where).toBeDefined();
    }
  });

  test('a DEEPER path, and a dotted negation on ANOTHER variable', () => {
    // Two levels, so the `pathOf` walk is more than one step.
    const deep = compilePredicate(undefined, parsePredicate('NOT (n.m.deep.z = 9)'), 'n');

    expect((deep.pathProps ?? []).length).toBe(1);
    expect(deep.pathProps?.[0].op).toBe('<>');

    // Another variable must not lift — the chain declines, as it did before this item.
    const other = compilePredicate(undefined, parsePredicate('NOT (q.m.k = 5)'), 'n');

    expect(other.pathProps).toBeUndefined();
    expect(other.where).toBeDefined();
  });

  test('⚠️ the two spellings answer identically, on every cell state', () => {
    // The whole point: equivalent spellings must not differ. `nok` has the record but not the
    // segment and `nom` has no record, so both read UNKNOWN and a filter keeps only clean TRUE —
    // they drop under BOTH spellings, which is why the answer is 2 and not 4.
    expect(ids('NOT (n.m.k = 5)')).toEqual(['k1', 'k9']);
    expect(ids('n.m.k <> 5')).toEqual(['k1', 'k9']);

    expect(ids('NOT (n.m.k <> 5)')).toEqual(['k5']);
    expect(ids('n.m.k = 5')).toEqual(['k5']);

    // The deeper path too.
    expect(ids('NOT (n.m.deep.z = 9)')).toEqual([]);
  });

  test('the lifted answer equals the GENERIC answer, spelling by spelling', () => {
    for (const where of [
      'NOT (n.m.k = 5)',
      'NOT (n.m.k <> 5)',
      'NOT (n.m.k = 99)',
      'NOT (n.m.other = 1)',
    ]) {
      const direct = compilePredicate(undefined, parsePredicate(where), 'n');
      const generic = compilePredicate(undefined, parsePredicate(where), undefined);

      // One lifts and the other cannot, or the oracle compares a route with itself.
      expect((direct.pathProps ?? []).length).toBeGreaterThan(0);
      expect(generic.pathProps).toBeUndefined();

      // Both of this engine's answers for the shape.
      const viaCount = Number(query(g, `MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)[0].c);

      expect(viaCount).toBe(ids(where).length);
    }
  });

  test('beside the other lifted families the chain is complete', () => {
    // A family dropped from a chain returns a SUPERSET — `hasPredicate`'s own recorded failure.
    expect(ids("NOT (n.m.k = 5) AND n.nm = 'k1'")).toEqual(['k1']);
    expect(ids("NOT (n.m.k = 5) AND n.nm = 'k5'")).toEqual([]);
    expect(ids('NOT (n.m.k = 5) AND n.nm IS NOT NULL')).toEqual(['k1', 'k9']);
  });

  test('⚠️ it survives a HOP, where the far-end MERGE must carry pathProps', () => {
    // The inline far constraint is what reaches `mergeFarPreds` — leaving it out is why item 1289's
    // equivalent mutant survived. Both far nodes satisfy the inline `{nm: 'x'}`; only one satisfies
    // the clause, so a dropped list answers 2.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['S'], properties: { nm: 'a' } });
    const keep = h.addVertex({ id: 'keep', labels: ['P'], properties: { nm: 'x', m: { k: 1 } } });
    const drop = h.addVertex({ id: 'drop', labels: ['P'], properties: { nm: 'x', m: { k: 5 } } });

    h.addEdge({ id: 'e1', from: a, to: keep, labels: ['T'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: drop, labels: ['T'], properties: {} });

    expect(
      Number(
        query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) WHERE NOT (b.m.k = 5) RETURN count(*) AS c")[0].c,
      ),
    ).toBe(1);

    // CONTROL: without the clause predicate both survive.
    expect(query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) RETURN b.nm AS nm").length).toBe(2);
  });
});
