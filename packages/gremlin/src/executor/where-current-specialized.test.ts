import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, as_, eq, gt, lt, neq, out, toArray, traversal, values, where } from '../index.js';

/**
 * `where(<predicate>)` — the tag-referencing form, after item 1900 gave its eq/neq case a
 * comparator chosen ONCE instead of a predicate object rebuilt per row.
 *
 * ⚠️ THE SPECIALIZATION IS SOUND ONLY BECAUSE `matches`' eq/neq arm IS `valueEq`, which is
 * `v === b` for every non-temporal operand (`predicates.ts` derives this for the fixed-operand
 * twin, `specializePredicate`). So the fast branch is guarded on `!isTemporal(end.value)` and the
 * ORDERING ops are not specialized at all — `gt` and friends go through `predCmp`, whose cross-type
 * NaN rule does not reduce to an operator.
 *
 * ⚠️ WHAT THESE TESTS DO **NOT** COVER, stated rather than implied: no shape reachable from this
 * surface puts a TEMPORAL in the tag while the current value is a DIFFERENT temporal object of equal
 * value, because the tag and the current value share one traverser lineage. The `isTemporal` guard
 * is therefore unproven-reachable soundness insurance, and unlike item 1899's dead adjacency arm it
 * is NOT deleted — item 1899 could prove its arm unreachable from the gate's own conditions, and
 * here that would mean proving it across every step that can rebind a traverser's value.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'c', n: 3 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'c' },
    // A SELF-LOOP, so the seed is reachable from itself and `neq` has something to drop.
    { id: 'e3', from: 'a', to: 'a' },
    { id: 'e4', from: 'b', to: 'a' },
  ]) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: ['E'],
    });
  }

  return g;
};

const ids = (rows: unknown[]): unknown[] => rows.map((r) => (r as { id: string }).id);

describe('where(predicate) against a tag — the eq/neq fast branch', () => {
  it('neq drops the tagged element and keeps the rest', () => {
    // `a`'s E-hop reaches b, c and a (the self-loop); `neq` drops the self.
    expect(
      ids(toArray(traversal(V('a'), as_('me'), out('E'), where(neq('me'))), fixture())),
    ).toStrictEqual(['b', 'c']);
  });

  /** ⚠️ `eq` IS THE OTHER HALF OF ONE FLAG, and a mutant that inverts it changes only this row. */
  it('eq keeps ONLY the tagged element', () => {
    expect(
      ids(toArray(traversal(V('a'), as_('me'), out('E'), where(eq('me'))), fixture())),
    ).toStrictEqual(['a']);
  });

  it('serves the whole graph, not just a seeded start', () => {
    // a -> b, c, a(dropped) | b -> a | c -> nothing
    expect(
      ids(toArray(traversal(V(), as_('me'), out('E'), where(neq('me'))), fixture())),
    ).toStrictEqual(['b', 'c', 'a']);
  });

  /** ⚠️ SCALARS, not elements: the same branch, with `===` over numbers rather than identity. */
  it('compares scalar values', () => {
    const g = fixture();

    expect(toArray(traversal(V(), values('n'), as_('x'), where(neq('x'))), g)).toStrictEqual([]);
    expect(toArray(traversal(V(), values('n'), as_('x'), where(eq('x'))), g)).toStrictEqual([
      1, 2, 3,
    ]);
  });

  /**
   * ⚠️ THE ORDERING OPS MUST STAY ON THE GENERAL PATH, and these rows are what says so: `predCmp`
   * filters a cross-type or missing value to false rather than erroring, which `===` cannot express.
   */
  it('an ordering op still routes through `matches`', () => {
    const g = fixture();

    // ⚠️ THE SCALAR PAIR IS VACUOUS AGAINST THE MUTANT THAT MATTERS, and the mutation run said so:
    // each traverser's `n` IS its own tagged `n`, so "not greater" and "not equal" agree and a
    // mutant routing `gt` through the equality branch answers `[]` either way.
    expect(toArray(traversal(V(), values('n'), as_('x'), where(gt('x'))), g)).toStrictEqual([]);
    expect(toArray(traversal(V(), values('n'), as_('x'), where(lt('x'))), g)).toStrictEqual([]);

    // ⚠️ THIS is the discriminating shape: a far VERTEX ordered against a tagged VERTEX is
    // incomparable, so `predCmp` yields NaN and every row is filtered — where the equality branch
    // would keep every row that is merely DIFFERENT (b and c).
    expect(ids(toArray(traversal(V('a'), as_('me'), out('E'), where(gt('me'))), g))).toStrictEqual(
      [],
    );
    expect(ids(toArray(traversal(V('a'), as_('me'), out('E'), where(lt('me'))), g))).toStrictEqual(
      [],
    );
  });

  it('drops a traverser whose referenced label is not bound', () => {
    expect(toArray(traversal(V(), out('E'), where(neq('nosuch'))), fixture())).toStrictEqual([]);
  });
});
