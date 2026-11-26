/**
 * **THE ONLY TESTS THAT CAN SEE `inlineFarIsPlainAnchor`** (item 2297). Admitting a far-driven walk is
 * answer-equivalent, so a mutation of the condition survives every differential test
 * (`perf-gate-needs-its-own-test`, items 1038/1044).
 *
 * **THE CORRECTNESS CONDITION IS EXHAUSTIVENESS.** `CPredicate` has eight families and only `props` is
 * safe to admit: an inline anchor is equality against a non-null literal, which can neither raise nor
 * coerce, so there is no expression for the gate's AST key to miss. Every other family must be refused
 * BY NAME — a ninth family added later must fail this test rather than slip through. These tests exist to
 * make a forgotten family fail loudly.
 */
import { describe, expect, test } from 'bun:test';

import { inlineFarIsPlainAnchor } from './executor/hop-projection.ts';

/** A `CPredicate` with only `props` populated — the shape `(b {k: 5})` compiles to. */
const plainAnchor = { props: [{ key: 'k', value: 5 }] };

describe('inlineFarIsPlainAnchor: props only, everything else refused by name', () => {
  test('admits a plain inline anchor — the 27x this exists for (item 2296: 108.42 -> 3.95 ms)', () => {
    expect(inlineFarIsPlainAnchor(plainAnchor as never)).toBe(true);
  });

  test('admits `undefined`, because no inline constraint is the pre-existing admitted case', () => {
    expect(inlineFarIsPlainAnchor(undefined)).toBe(true);
  });

  test('refuses an EMPTY props list — nothing to filter on is not an anchor', () => {
    expect(inlineFarIsPlainAnchor({ props: [] })).toBe(false);
  });

  test('admits `eqProps`, because the CLAUSE path already runs that exact compiled predicate (item 2298)', () => {
    /*
     * Instrumenting the three spellings showed `farPred` IDENTICAL for the clause form and the inline
     * `WHERE` — `[props:0, eqProps:1]` in both — and the clause form was already admitted. So admitting
     * `eqProps` gives the walk nothing new; it removes a discrimination between two spellings of one
     * predicate. Worth 24.2x (102.13 → 4.22 ms).
     */
    expect(inlineFarIsPlainAnchor({ props: [], eqProps: [{ key: 'k', value: 5 }] } as never)).toBe(
      true,
    );
  });

  test('refuses EVERY family that is NOT props or eqProps, each with its own witness', () => {
    const refused = [
      'where',
      'cmpProps',
      'truthProps',
      'notTruthProps',
      'memberProps',
      'nullProps',
    ] as const;

    for (const family of refused) {
      /* Populated alongside a valid `props`, so only the extra family can be what refuses it. */
      const pred = { ...plainAnchor, [family]: family === 'where' ? () => true : [{ key: 'x' }] };

      expect(inlineFarIsPlainAnchor(pred as never)).toBe(false);
    }

    /*
     * THE LIST MUST STAY COMPLETE. `CPredicate` had exactly eight families at item 2298; two are
     * admitted (`props`, `eqProps`) and these six are refused. A ninth added later makes this fail,
     * which is the point — a forgotten family would be admitted silently otherwise.
     */
    expect(refused.length + 2).toBe(8);
  });

  test('`nullProps` is refused in particular: `{k: null}` is IS NULL, not an equality (item 260)', () => {
    expect(inlineFarIsPlainAnchor({ props: [], nullProps: [{ key: 'k' }] } as never)).toBe(false);
    expect(inlineFarIsPlainAnchor({ ...plainAnchor, nullProps: [{ key: 'z' }] } as never)).toBe(
      false,
    );
  });
});
