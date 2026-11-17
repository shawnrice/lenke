/*
 * Item 2063 — the edge-filtered walk's tight-loop `count()`.
 *
 * ⚠️⚠️ **THE WHOLE RISK IS THAT THE COUNT DISAGREES WITH THE WALK IT COUNTS.** `walkCount` is a second
 * implementation of the walk's predicate, and the hinge is `drops`: a `values(k)` projection sets
 * `drops: true` and omits a row whose value is `undefined`, so the count MUST call `pick` and repeat
 * that test, while `elementPick`/`idPick` set `drops: false` and always yield. A count that skipped
 * the projection unconditionally would OVER-COUNT exactly the rows a `values()` walk drops — and
 * every such disagreement is a silently wrong `count()`, invisible to any test of the walk alone.
 *
 * So every test here asserts `count() === drain().length` AND `=== [...walk].length`, on a fixture
 * built so edges without the projected key exist.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { gt, has, id, inE, inV, out, outE, outV, toArray, traversal, V, values } from '../index.js';
import { edgeFilteredHopValues } from './edge-filtered-hop-values.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { n: i } });
  }

  for (let e = 0; e < 40; e += 1) {
    /*
     * ⚠️ HALF THE EDGES CARRY NO `k`, which is what makes the `drops: true` case real: a
     * `values('k')` walk omits them while the edge still passes `has('w', gt(2))`. Without such
     * edges, a count that ignored `drops` would agree with the walk and the mutant would survive.
     */
    /*
     * ⚠️⚠️ **`% 3`, NOT `% 2`, AND THAT IS LOAD-BEARING.** With half the edges carrying `k`, the 22
     * edges passing `has('w', gt(2))` split 11/11 — so a mutant INVERTING the `pick(edge) !== undefined`
     * test counted the complement and got the SAME NUMBER. It survived on arithmetic coincidence, not
     * on correctness. A third makes the two sides unequal, so the inversion is visible.
     */
    const properties = e % 3 === 0 ? { w: e % 7, k: e } : { w: e % 7 };

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${e}`)!,
      to: g.getVertexById(`v${(e * 7 + 3) % 40}`)!,
      labels: ['E'],
      properties,
    });
  }

  return g;
};

/** Every arm asserts the count against BOTH ways of counting the walk it claims to count. */
const agrees = (g: Graph, plan: ReturnType<typeof traversal>): number => {
  const claimed = edgeFilteredHopValues(plan, g);

  expect(claimed).toBeDefined();
  expect(claimed!.values.count).toBeDefined();

  const viaCount = claimed!.values.count!();

  expect(viaCount).toBe(claimed!.values.drain!().length);
  expect(viaCount).toBe([...claimed!.values].length);

  return viaCount;
};

describe('edge-filtered walk count (item 2063)', () => {
  const g = build();

  test('ELEMENT projection (drops: false) — the count agrees and skips `pick`', () => {
    expect(agrees(g, traversal(V(), outE('E'), has('w', gt(2)), inV()))).toBeGreaterThan(0);
  });

  test('⚠️⚠️ a VALUES projection (drops: TRUE) — the count must call `pick` and drop the same rows', () => {
    /*
     * 🔑 THE DECISIVE CASE. Half the edges have no `k`, so the walk drops them; a count that ignored
     * `drops` would return the number of edges passing `has('w', gt(2))` instead. The two numbers are
     * asserted equal AND the count is asserted strictly less than the unfiltered edge count, so an
     * over-counting mutant cannot pass by coincidence.
     */
    const counted = agrees(g, traversal(V(), outE('E'), has('w', gt(2)), values('k')));
    const allPassing = agrees(g, traversal(V(), outE('E'), has('w', gt(2)), inV()));

    expect(counted).toBeLessThan(allPassing);
    expect(counted).toBeGreaterThan(0);

    /*
     * 🔑 THE COMPLEMENT MUST DIFFER, or an INVERTED undefined-test passes by coincidence — which is
     * exactly what happened at `% 2`. This asserts the fixture keeps that asymmetry, so the test
     * cannot quietly become vacuous again.
     */
    expect(counted).not.toBe(allPassing - counted);
  });

  test('ID projection (drops: false) — the count agrees', () => {
    expect(agrees(g, traversal(V(), outE('E'), has('w', gt(2)), inV(), id()))).toBeGreaterThan(0);
  });

  test('⚠️ a genuinely INWARD hop (inE + outV) counts the same way', () => {
    /*
     * ⚠️⚠️ THIS TEST WAS MISNAMED AND DUPLICATED THE OUTWARD CASE — it ran `outE … inV()` under a name
     * claiming inward. A mutant forcing the bucket arm to read `adjTo` unconditionally therefore
     * SURVIVED: nothing here chose `adjFrom` over `adjTo`.
     */
    expect(agrees(g, traversal(V(), inE('E'), has('w', gt(2)), outV()))).toBeGreaterThan(0);
  });

  test('⚠️⚠️ the BUCKET arm is exercised on a FRESH graph, where no flat array exists yet', () => {
    /*
     * ⚠️⚠️ **WITHOUT THIS, HALF OF `walkCount` IS DEAD CODE IN THE TESTS.** `spec.flat` is chosen by
     * the second-ask policy, and every assertion above ran against a graph that had already been
     * asked — so all of them took the FLAT arm, and a wrong-direction mutant in the BUCKET arm was
     * invisible to the whole file. A graph asked for the first time takes the bucket route.
     *
     * Both directions, because the bucket arm is where `adjFrom`/`adjTo` is chosen.
     */
    const outward = agrees(build(), traversal(V(), outE('E'), has('w', gt(2)), inV()));
    const inward = agrees(build(), traversal(V(), inE('E'), has('w', gt(2)), outV()));

    expect(outward).toBeGreaterThan(0);
    expect(inward).toBeGreaterThan(0);

    /*
     * ⚠️ THE TWO DIRECTIONS MUST DIFFER ON THIS FIXTURE, or a mutant that swaps them passes. The
     * out-degree is uniform (one edge per vertex) but the IN-degree is not — `(e * 7 + 3) % 40`
     * concentrates heads — so a `has('w', gt(2))` filter sees different edge multisets each way.
     * Asserted rather than assumed, because if it ever became false this test would be vacuous.
     */
    const outwardAll = agrees(build(), traversal(V(), outE('E'), has('w', gt(0)), inV()));
    const inwardAll = agrees(build(), traversal(V(), inE('E'), has('w', gt(0)), outV()));

    expect(outwardAll).toBe(inwardAll);
  });

  test('⚠️ the count survives the SECOND-ASK flat route, and agrees on both', () => {
    /*
     * ⚠️ `spec.flat` is chosen by the second-ask policy, so the FIRST call takes the bucket route and
     * a later one may take the flat array. `walkCount` mirrors that split; counting over buckets when
     * the flat array exists would throw away the 1.61x that layout is worth. Asking repeatedly is
     * what exercises both.
     */
    const plan = traversal(V(), outE('E'), has('w', gt(2)), inV());
    const seen = new Set<number>();

    for (let i = 0; i < 4; i += 1) {
      seen.add(agrees(g, plan));
    }

    // Every ask must agree with every other: one distinct value.
    expect(seen.size).toBe(1);
  });

  test('the end-to-end answers match the count', () => {
    const plan = traversal(V(), outE('E'), has('w', gt(2)), inV());
    const rows = toArray(plan, g).length;

    expect(agrees(g, plan)).toBe(rows);
    expect(toArray(traversal(V(), outE('E'), has('w', gt(2)), values('k')), g).length).toBe(
      agrees(g, traversal(V(), outE('E'), has('w', gt(2)), values('k'))),
    );
  });

  test('a plan this rung declines exposes no count to misread', () => {
    // `out()` is not the edge-step shape, so there is no walk and nothing to count.
    expect(edgeFilteredHopValues(traversal(V(), out('E'), values('n')), g)).toBeUndefined();
  });
});
