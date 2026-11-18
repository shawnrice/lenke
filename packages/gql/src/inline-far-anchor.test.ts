/**
 * ⚠️⚠️ **THE ONLY TESTS THAT CAN SEE `inlineFarIsPlainAnchor`** (item 2297). Admitting a far-driven walk is
 * answer-equivalent, so a mutation of the condition survives every differential test
 * (`perf-gate-needs-its-own-test`, items 1038/1044).
 *
 * 🔑 **THE CORRECTNESS CONDITION IS EXHAUSTIVENESS.** `CPredicate` has eight families and only `props` is
 * safe to admit: an inline anchor is equality against a non-null literal, which can neither raise nor
 * coerce, so there is no expression for the gate's AST key to miss. ⚠️ Every other family must be refused
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

  test('⚠️ refuses an EMPTY props list — nothing to filter on is not an anchor', () => {
    expect(inlineFarIsPlainAnchor({ props: [] })).toBe(false);
  });

  test('⚠️ refuses EVERY other family by name, each with its own witness', () => {
    const families = [
      'where',
      'eqProps',
      'cmpProps',
      'truthProps',
      'notTruthProps',
      'memberProps',
      'nullProps',
    ] as const;

    for (const family of families) {
      /* Populated alongside a valid `props`, so only the extra family can be what refuses it. */
      const pred = { ...plainAnchor, [family]: family === 'where' ? () => true : [{ key: 'x' }] };

      expect(inlineFarIsPlainAnchor(pred as never)).toBe(false);
    }

    /* The list above must stay complete: CPredicate had exactly eight families at item 2297. */
    expect(families.length + 1).toBe(8);
  });

  test('⚠️ `nullProps` is refused in particular: `{k: null}` is IS NULL, not an equality (item 260)', () => {
    expect(inlineFarIsPlainAnchor({ props: [], nullProps: [{ key: 'k' }] } as never)).toBe(false);
    expect(inlineFarIsPlainAnchor({ ...plainAnchor, nullProps: [{ key: 'z' }] } as never)).toBe(
      false,
    );
  });
});
