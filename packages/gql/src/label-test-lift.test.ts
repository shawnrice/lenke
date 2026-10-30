import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, hasPredicate } from './executor.js';
import { query } from './index.js';
import { parsePredicate } from './parser.js';

// `WHERE n IS LABELED P` now lifts into `labelTests` (item 1289) — the `isLabeled` leaf item 1272
// listed as declined and item 1288 priced:
//
//     n.a >= 0            4.076 ms   a compare every row satisfies
//     n IS LABELED P     10.656      2.61x
//
// ⚠️ THE SUBJECT IS THE ELEMENT, NOT A PROPERTY, which makes this the first lifted family with no
// `key`: every other one reads `propOf(element, key)` and this one reads `element.labels`. It is
// also the only arm in `directEqProps`' loop that matches a `var` rather than a `prop`.
//
// It is TOTAL AND NON-RAISING — `case 'isLabeled'` yields `isElement(el) ? labelsMatch(...) : false`,
// a plain boolean — and the native engine HOISTS it past a faulting sibling (measured at item 1288),
// so it sits in the non-raising group with `nullProps` and `memberProps`.
//
// ⚠️ THE FIXTURE MUST BE DISCRIMINATING. The timing probe used `MATCH (n:P) WHERE n IS LABELED P`,
// where the pattern already guarantees the label and the predicate is vacuous — fine for measuring
// pure route cost, useless for correctness. Every query below starts from an UNTYPED pattern so the
// predicate is the only thing filtering.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'p', labels: ['P'], properties: { nm: 'p' } });
  g.addVertex({ id: 'q', labels: ['Q'], properties: { nm: 'q' } });
  g.addVertex({ id: 'pq', labels: ['P', 'Q'], properties: { nm: 'pq' } });
  g.addVertex({ id: 'r', labels: ['R'], properties: { nm: 'r' } });
  g.addVertex({ id: 'none', labels: [], properties: { nm: 'none' } });

  return g;
};

const g = build();
const ids = (where: string): string[] =>
  query(g, `MATCH (n) WHERE ${where} RETURN n.nm AS nm`)
    .map((r) => String(r.nm))
    .sort();

describe('IS LABELED lifts into labelTests (item 1289)', () => {
  test('⚠️ ROUTE: every spelling lands in labelTests and nothing is left behind', () => {
    // Answer-equivalent by design, so only the compiler can see it.
    const lifted = (src: string): number =>
      (compilePredicate(undefined, parsePredicate(src), 'n').labelTests ?? []).length;

    expect(lifted('n IS LABELED P')).toBe(1);
    expect(lifted('n IS NOT LABELED P')).toBe(1);
    expect(lifted('NOT (n IS LABELED P)')).toBe(1);
    expect(lifted('n IS LABELED P | Q')).toBe(1);

    // The negated flag is what the two spellings differ by, and `NOT (…)` folds into it.
    const pos = compilePredicate(undefined, parsePredicate('n IS LABELED P'), 'n');
    const neg = compilePredicate(undefined, parsePredicate('n IS NOT LABELED P'), 'n');
    const notted = compilePredicate(undefined, parsePredicate('NOT (n IS LABELED P)'), 'n');

    expect(pos.labelTests?.[0].negated).toBe(false);
    expect(neg.labelTests?.[0].negated).toBe(true);
    expect(notted.labelTests?.[0].negated).toBe(true);

    // Fully lifted leaves NOTHING for the generic evaluator — the item 277 class.
    expect(pos.where).toBeUndefined();

    // ⚠️ AND `hasPredicate` MUST SEE IT. A mutation run is why this line is here rather than
    // assumed: dropping `labelTests` from `hasPredicate` SURVIVED all 4,200 tests until this
    // assertion existed. `hasPredicate`'s own doc is explicit that every gate deciding "can I skip
    // applying this predicate" goes through it, so a list forgotten there reintroduces the item 277
    // bug — and no query-level test in this file reached such a gate.
    expect(hasPredicate(pos)).toBe(true);
    expect(hasPredicate(neg)).toBe(true);
  });

  test('a test on ANOTHER variable, or on a non-variable subject, is not lifted', () => {
    expect(
      compilePredicate(undefined, parsePredicate('m IS LABELED P'), 'n').labelTests,
    ).toBeUndefined();
    // The subject must be the bare variable: a property read is a different question and the
    // `isElement` guard in the generic arm is what handles it.
    expect(
      compilePredicate(undefined, parsePredicate('n.k IS LABELED P'), 'n').labelTests,
    ).toBeUndefined();
  });

  test('the answers filter, on a fixture where the predicate is the only filter', () => {
    expect(ids('n IS LABELED P')).toEqual(['p', 'pq']);
    expect(ids('n IS LABELED Q')).toEqual(['pq', 'q']);
    // IS NOT LABELED keeps everything else, INCLUDING the node with no labels at all.
    expect(ids('n IS NOT LABELED P')).toEqual(['none', 'q', 'r']);
    expect(ids('NOT (n IS LABELED P)')).toEqual(['none', 'q', 'r']);
  });

  test('⚠️ a LABEL EXPRESSION is carried whole, not reduced to one name', () => {
    // `labelsMatch` handles the conjunction/disjunction/negation forms, and the lift stores the
    // whole `LabelExpr` rather than a string — so a composite must answer identically through the
    // lift. A carrier that kept only a name would answer this wrong.
    expect(ids('n IS LABELED P | Q')).toEqual(['p', 'pq', 'q']);
    expect(ids('n IS LABELED P & Q')).toEqual(['pq']);
    expect(ids('n IS LABELED !P')).toEqual(['none', 'q', 'r']);
  });

  test('the lifted answer equals the GENERIC answer, spelling by spelling', () => {
    // The oracle: compiled without an own-var it cannot lift, so it runs the generic arm. Any
    // disagreement is the lift changing an answer.
    for (const where of [
      'n IS LABELED P',
      'n IS NOT LABELED P',
      'n IS LABELED P | Q',
      'n IS LABELED P & Q',
      'n IS LABELED !P',
      'NOT (n IS LABELED Q)',
      'n IS LABELED Z',
    ]) {
      const direct = compilePredicate(undefined, parsePredicate(where), 'n');
      const generic = compilePredicate(undefined, parsePredicate(where), undefined);

      expect((direct.labelTests ?? []).length).toBeGreaterThan(0);
      expect(generic.labelTests).toBeUndefined();

      // Both of this engine's answers for the shape: the row path and the tally.
      const viaRows = ids(where).length;
      const viaCount = Number(query(g, `MATCH (n) WHERE ${where} RETURN count(*) AS c`)[0].c);

      expect(viaCount).toBe(viaRows);
    }
  });

  test('beside the other lifted families, the chain is complete', () => {
    // A family dropped from a chain returns a SUPERSET — the failure `hasPredicate`'s doc records.
    expect(ids("n IS LABELED P AND n.nm = 'p'")).toEqual(['p']);
    expect(ids("n IS LABELED P AND n.nm = 'q'")).toEqual([]);
    expect(ids('n IS LABELED P AND n.nm IS NOT NULL')).toEqual(['p', 'pq']);
    expect(ids("n IS LABELED P AND n.nm NOT IN ['p']")).toEqual(['pq']);
  });

  test('⚠️ it survives a HOP, and the far-end MERGE must carry it', () => {
    // ⚠️ THE INLINE FAR CONSTRAINT IS WHAT REACHES `mergeFarPreds`, and leaving it out is why the
    // `merge-drops-family` mutant SURVIVED the first version of this test. That function merges an
    // INLINE far constraint with the lifted clause predicate; with no inline half it is never
    // entered, so a dropped list cannot show. This mirrors `null-props-lift.test.ts`'s own merge
    // case, which carries `{s: 'xx'}` for the same reason.
    //
    // Both far nodes satisfy the inline `{nm: 'x'}`; only one satisfies the clause `IS LABELED P`.
    // A merge that dropped `labelTests` answers 2 — a SUPERSET, which is a wrong answer and not a
    // slow one.
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['S'], properties: { nm: 'a' } });
    const keep = h.addVertex({ id: 'keep', labels: ['P'], properties: { nm: 'x' } });
    const drop = h.addVertex({ id: 'drop', labels: ['R'], properties: { nm: 'x' } });

    h.addEdge({ id: 'e1', from: a, to: keep, labels: ['T'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: drop, labels: ['T'], properties: {} });

    expect(
      Number(
        query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) WHERE b IS LABELED P RETURN count(*) AS c")[0].c,
      ),
    ).toBe(1);

    // And the row path for the same question.
    expect(
      query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) WHERE b IS LABELED P RETURN b.nm AS nm").length,
    ).toBe(1);

    // CONTROL: without the clause predicate both survive, so the 1 above is the predicate working
    // rather than the fixture being empty.
    expect(query(h, "MATCH (p:S)-[:T]->(b {nm: 'x'}) RETURN b.nm AS nm").length).toBe(2);
  });

  test('a label test is the ONLY constraint on a product factor', () => {
    // An unconstrained factor is answered from a bucket SIZE, so a dropped label test would
    // multiply the whole graph instead of the two P nodes. This pins the ANSWER, which no
    // assertion on the compiler can.
    expect(
      Number(query(g, 'MATCH (a), (b:R) WHERE a IS LABELED P RETURN count(*) AS c')[0].c),
    ).toBe(2);
    expect(
      Number(query(g, 'MATCH (a), (b:R) WHERE a IS LABELED P | Q RETURN count(*) AS c')[0].c),
    ).toBe(3);
  });

  test('an INLINE test actually filters — the item 277 class', () => {
    // A predicate that lifts ENTIRELY leaves `where` undefined, so a gate asking "is this node
    // constrained?" by looking only at `where` sees nothing. `hasPredicate` is the one definition.
    expect(
      query(g, 'MATCH (n WHERE n IS LABELED P) RETURN n.nm AS nm')
        .map((r) => String(r.nm))
        .sort(),
    ).toEqual(['p', 'pq']);

    expect(
      query(g, 'MATCH (n) WHERE EXISTS { MATCH (n WHERE n IS LABELED P) } RETURN n.nm AS nm')
        .map((r) => String(r.nm))
        .sort(),
    ).toEqual(['p', 'pq']);
  });
});
