import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { effectivePlan, toArray } from './executor.js';
import { V, as_, both, count, limit, match, out, pipe, select, traversal } from './index.js';

/**
 * `flattenLinearMatch` (item 1797): a linear `match(…)` whose only tail is `count()` becomes the
 * hop chain it is equivalent to.
 *
 * ```text
 *   V().match(a-E->b).count()            863.8 ms  ->    4.6   188x
 *   V().match(a-E->b, b-E->c).count()   4719.7     ->   54.3    87x
 *   V().match(…).select('c').count()    6684       -> 6451.8    declined, and that is the CONTROL
 * ```
 *
 * ⚠️ **ITEM 1655 BUILT THIS AND REVERTED IT AS A WRONG ANSWER. Its reason was a BUG, not a semantic
 * difference**, and this file exists mostly to hold that distinction. It concluded "`match()`
 * counts distinct variable BINDINGS; a hop chain counts PATHS" from a fixture where one parallel
 * edge separated them — but TinkerPop 3.7.3, asked directly at item 1793, answers the CHAIN's
 * number for both. The TS solver was deduping solutions; items 1793 and 1794 fixed that in its two
 * arms. **So the parallel-edge fixture that refuted the rewrite is now the fixture that validates
 * it**, and it is the first thing tested below.
 *
 * ⚠️ **ITEM 1655's SECOND OBJECTION STANDS AND IS WHY THE TAIL MUST BE `count()`**: a `match` step
 * emits a TAG MAP, a chain emits the end ELEMENT. Anything that can observe the value is refused.
 */

/** Hostile on purpose: parallel edges, a self loop, a multi-label edge, a sink, a second type. */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const v = (id: string): Vertex => g.getVertexById(id) as Vertex;
  let e = 0;
  const edge = (from: string, to: string, labels: string[]): void => {
    g.addEdge({ id: `e${(e += 1)}`, from: v(from), to: v(to), labels, properties: {} });
  };

  edge('a', 'b', ['T']);
  edge('a', 'b', ['T']); // PARALLEL — item 1655's refutation, now the validation
  edge('b', 'c', ['T']);
  edge('c', 'c', ['T']); // SELF LOOP
  edge('c', 'a', ['T', 'S']); // MULTI-LABEL
  edge('a', 'd', ['S']); // a second type the typed hop must exclude; `d` is a sink on T

  return g;
};

const ONE = pipe(as_('a'), out('T'), as_('b'));
const TWO = pipe(as_('b'), out('T'), as_('c'));
const kindsOf = (plan: ReturnType<typeof traversal>): string[] =>
  effectivePlan(plan, fixture(), false).steps.map((s) => s.kind);

describe('the rewrite fires exactly where it is equivalent', () => {
  test('a one-pattern match + count becomes the hop + count', () => {
    expect(kindsOf(traversal(V(), match(ONE), count()))).toEqual(['V', 'out', 'count']);
  });

  test('a two-pattern linear chain becomes two hops', () => {
    expect(kindsOf(traversal(V(), match(ONE, TWO), count()))).toEqual(['V', 'out', 'out', 'count']);
  });

  test('a `both` leg is admitted — it is the same walk', () => {
    const plan = traversal(V(), match(pipe(as_('a'), both('T'), as_('b'))), count());

    expect(kindsOf(plan)).toEqual(['V', 'both', 'count']);
  });
});

describe('⚠️ the rewrite DECLINES everything it cannot prove equal', () => {
  test('a repeated tag is a JOIN the chain cannot express', () => {
    // `match(a->b, b->a)` constrains the walk to return to its start; `out(T).out(T)` does not.
    const back = pipe(as_('b'), out('T'), as_('a'));

    expect(kindsOf(traversal(V(), match(ONE, back), count()))).toEqual(['V', 'match', 'count']);
  });

  test('patterns that are not a chain in written order', () => {
    // The solver may reorder patterns; a chain cannot, so written order is required rather than
    // reasoned about.
    const far = pipe(as_('x'), out('T'), as_('y'));

    expect(kindsOf(traversal(V(), match(ONE, far), count()))).toEqual(['V', 'match', 'count']);
  });

  test('a tail that can OBSERVE the step value — item 1655 standing objection', () => {
    expect(kindsOf(traversal(V(), match(ONE, TWO), select('c'), count()))).toEqual([
      'V',
      'match',
      'select',
      'count',
    ]);
    // `limit(n)` lowers to a `take` step, which is why the expectation names the KIND rather than
    // the builder — the rewrite reads kinds and so must this.
    expect(kindsOf(traversal(V(), match(ONE), limit(2), count()))).toEqual([
      'V',
      'match',
      'take',
      'count',
    ]);
    expect(kindsOf(traversal(V(), match(ONE)))).toEqual(['V', 'match']);
  });

  test('a pattern that is not exactly as(x).<one hop>.as(y)', () => {
    const twoHops = pipe(as_('a'), out('T'), out('T'), as_('b'));
    const noTail = pipe(as_('a'), out('T'));

    expect(kindsOf(traversal(V(), match(twoHops), count()))).toEqual(['V', 'match', 'count']);
    expect(kindsOf(traversal(V(), match(noTail), count()))).toEqual(['V', 'match', 'count']);
  });
});

describe('⚠️ the ANSWER is unchanged, on the fixture that refuted item 1655', () => {
  const g = fixture();
  const answer = (plan: ReturnType<typeof traversal>): unknown[] => toArray(plan, g);

  test('one pattern over PARALLEL edges equals the bare hop count', () => {
    // Four `T` edges out of some vertex: a->b twice, b->c, c->c, c->a. The parallel pair is what
    // item 1655 read as a semantic difference.
    expect(answer(traversal(V(), match(ONE), count()))).toEqual([5]);
    expect(answer(traversal(V(), out('T'), count()))).toEqual([5]);
  });

  test('two patterns equal the two-hop chain', () => {
    expect(answer(traversal(V(), match(ONE, TWO), count()))).toEqual(
      answer(traversal(V(), out('T'), out('T'), count())),
    );
  });

  test('the DECLINED cyclic shape is NOT the chain, which is why it is declined', () => {
    // The guard earns its place only if the two genuinely differ here. `match(a->b, b->a)` admits
    // only walks that come back; the chain admits every two-hop walk.
    const back = pipe(as_('b'), out('T'), as_('a'));
    const cyclic = answer(traversal(V(), match(ONE, back), count()));

    expect(cyclic).not.toEqual(answer(traversal(V(), out('T'), out('T'), count())));
  });

  test('a typed hop still excludes the other type', () => {
    // `a -S-> d` must not be walked by `out('T')`, and `d` is a sink, so a rewrite that dropped
    // the labels would change the count.
    expect(answer(traversal(V(), match(ONE), count()))).not.toEqual(
      answer(traversal(V(), out(), count())),
    );
  });
});
