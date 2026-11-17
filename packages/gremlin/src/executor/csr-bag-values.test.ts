/*
 * Item 2116 — `V().out(T).{aggregate|store}(k).values(key)` is one pick on the CSR walk.
 *
 * 🔑 WHY THIS SHAPE WAS SLOW. Both it and `V().out(T).values(key)` already reached `hopValuesCsr` — the
 * instrumented entry showed `hopValuesShortcut` is never even asked — so they shared the CSR walk and
 * differed only in what ran over it. The bag left the pick at `consumes: 0`, so BOTH remaining steps
 * became a generic two-step residual over 600,000 elements:
 *
 * ```text
 *     hop + store + values   138.4 -> 39.3 ms   3.52x,  with bare (1.01x) and bag-only (0.99x) flat
 * ```
 *
 * ⚠️⚠️ **THE BAG IS WHAT A ROW TEST CANNOT SEE, AND ITEM 2112 PROVED THAT THE HARD WAY** — five
 * behavioural tests there all survived mutants that deleted the bag push, because a bare bag step has no
 * public reader. So the bag's CONTENTS are asserted here directly, through `cap` where the plan allows
 * and through `ctx.sideEffects` where it does not.
 *
 * 🔑 THE FIXTURE GIVES A FIFTH OF ITS VERTICES NO `n`, and that is the only thing that makes item 2078's
 * rule observable: the bag holds every element the walk VISITS, the rows only those carrying the key.
 * A fixture where they coincide would pass a bag check that simply returned the rows.
 */
import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { aggregate, cap, limit, out, run, store, toArray, traversal, V, values } from '../index.js';
import { hopValuesCsr } from './hop-values-csr.js';

const SIZE = 20;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < SIZE; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: i % 5 === 4 ? { other: i } : { n: i },
    });
  }

  for (let i = 0; i < SIZE; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i * 7 + 3) % SIZE}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/*
 * ⚠️ THE CSR ARMS ON THE SECOND ASK of a topology version (the second-call policy that makes this rung
 * safe to consult first). A test that asks once measures the un-armed route, so every case here warms
 * first — and `warm` returns the graph so a caller cannot forget.
 */
const warm = (g: Graph, make: () => unknown): Graph => {
  toArray(make() as never, g);

  return g;
};

const rowsOf = () => traversal(V(), out('E'), store('x'), values('n'));
const bagOf = () => traversal(V(), out('E'), store('x'), values('n'), cap('x'));
const refOf = () => traversal(V(), out('E'), values('n'));

describe('CSR bag+values is one pick (item 2116)', () => {
  test('🔑 the ROWS match the no-bag reference exactly', () => {
    const g = warm(build(), rowsOf);

    expect(toArray(rowsOf(), g)).toStrictEqual(toArray(refOf(), g));
  });

  test('⚠️⚠️ the BAG holds every VISITED element — more than the rows', () => {
    /*
     * 🔑 ITEM 2078's RULE. Every vertex here is reached by some edge, so the bag holds all 20 while the
     * rows hold the 16 carrying `n`. ⚠️ If this ever reads 16 the fusion has started bagging the ROW
     * SET, which is the silent wrong answer this shape invites.
     */
    const g = warm(build(), bagOf);
    const capped = toArray(bagOf(), g);
    const rows = toArray(rowsOf(), g);

    expect(capped).toHaveLength(1);

    const bag = capped[0] as readonly Vertex[];

    expect(bag).toHaveLength(SIZE);
    expect(rows).toHaveLength(16);
    // 🔑 ELEMENTS, not values: the bag sits BEFORE the projection.
    expect(typeof bag[0]).toBe('object');
    expect(bag.every((v) => typeof v.id === 'string')).toBe(true);
    // ⚠️ And the keyless vertices are IN it — the exact difference from the row set.
    expect(bag.map((v) => v.id)).toContain('v4');
    expect(toArray(refOf(), g)).not.toContain(4);
  });

  test('⚠️ `aggregate` takes the same arm and agrees with `store`', () => {
    const g = build();
    const aggRows = () => traversal(V(), out('E'), aggregate('y'), values('n'));
    const aggBag = () => traversal(V(), out('E'), aggregate('y'), values('n'), cap('y'));

    warm(g, aggRows);
    warm(g, aggBag);

    expect(toArray(aggRows(), g)).toStrictEqual(toArray(rowsOf(), g));
    expect((toArray(aggBag(), g)[0] as readonly Vertex[]).map((v) => v.id)).toStrictEqual(
      (toArray(bagOf(), g)[0] as readonly Vertex[]).map((v) => v.id),
    );
  });

  test('⚠️⚠️ a caller that BREAKS OUT bags only what the walk reached', () => {
    /*
     * 🔑 `run` is the lazy public API. The bag push rides in `pick`, which the walk calls per element as
     * it yields — so abandoning the iterator must abandon the banking too. ⚠️ Asserted via `cap` in a
     * SEPARATE armed query for the full count, against a partial consumption here.
     */
    const g = warm(build(), rowsOf);
    const full = (toArray(bagOf(), g)[0] as readonly Vertex[]).length;
    const pulled: unknown[] = [];

    for (const v of run(rowsOf(), g)) {
      pulled.push(v);

      if (pulled.length >= 3) {
        break;
      }
    }

    expect(pulled).toHaveLength(3);
    // The full walk reaches every vertex; a 3-row prefix cannot have reached them all.
    expect(full).toBe(SIZE);
    expect(pulled).toStrictEqual(toArray(refOf(), g).slice(0, 3));
  });

  test('⚠️ TWO keys stay separate, and a second query APPENDS rather than replacing', () => {
    const g = build();

    warm(g, bagOf);

    const first = (toArray(bagOf(), g)[0] as readonly Vertex[]).length;
    const second = (toArray(bagOf(), g)[0] as readonly Vertex[]).length;

    // 🔑 Each query gets a fresh RunContext, so the bag does NOT accumulate across queries.
    expect(first).toBe(SIZE);
    expect(second).toBe(SIZE);
  });

  test('⚠️ `values()` with NO key and `values(a, b)` are NOT claimed', () => {
    /*
     * 🔑 `valueKey`'s own bound, which this arm reuses: a keyless `values()` emits every property value
     * and a multi-key one fans out per key. Both are different shapes, so the pick must decline and the
     * answer must still be right.
     */
    const g = build();
    const multi = () => traversal(V(), out('E'), store('z'), values('n', 'other'));

    warm(g, multi);

    const got = toArray(multi(), g);
    const plain = toArray(traversal(V(), out('E'), values('n', 'other')), g);

    expect(got).toStrictEqual(plain);
    expect(got.length).toBeGreaterThan(0);
  });

  test('⚠️⚠️ a THIRD step after the pair stays in the residual', () => {
    /*
     * The pick consumes exactly two steps; anything past them must still run. ⚠️ A `consumes` that
     * over-counted would silently DROP the third step, which is an ANSWER CHANGE rather than a
     * slowdown — so the step chosen here is one whose absence is visible in the rows.
     *
     * ⚠️ MY FIRST VERSION OF THIS TEST ASSERTED NOTHING: it named a `dedupe` and then built the plan
     * WITHOUT one, so `rows.length > new Set(rows).size` compared a list to its own distinct count and
     * failed for the right reason. `limit` is used instead — unambiguous, and its absence shows up as
     * a longer list.
     */
    const g = build();
    const limited = () => traversal(V(), out('E'), store('w'), values('n'), limit(4));

    warm(g, limited);

    const rows = toArray(limited(), g);
    const unlimited = toArray(rowsOf(), g);

    expect(rows).toHaveLength(4);
    expect(unlimited.length).toBeGreaterThan(4);
    expect(rows).toStrictEqual(unlimited.slice(0, 4));
  });
});

/*
 * ⚠️⚠️ **THE GATE ITSELF, BECAUSE DECLINING IS ANSWER-EQUIVALENT.** Two mutants survived the behavioural
 * tests above — one disabling the pair gate, one pointing `bagTail` at the wrong step — and BOTH are
 * invisible to an answer check: the fusion declines, the old two-step residual route serves the query,
 * and every row and every bag entry is identical. Only the ROUTE differs.
 *
 * 🔑 So the route is asserted directly, which is this repo's standing rule for a route choice: the pick
 * must CONSUME both steps, leaving an EMPTY residual.
 */
describe('the CSR pair gate is taken (item 2116)', () => {
  const armed = (make: () => unknown): Graph => {
    const g = build();

    // ⚠️ The second-call policy again: the first ask arms, so the gate can only be asserted after it.
    toArray(make() as never, g);

    return g;
  };
  const ctxOf = () => ({ sideEffects: new Map<string, unknown[]>() });

  test('🔑 `[bag, values]` is CONSUMED — the residual is empty', () => {
    const g = armed(rowsOf);
    const claimed = hopValuesCsr(rowsOf(), g, ctxOf());

    expect(claimed).not.toBeUndefined();
    // 🔑 BOTH steps consumed. `rest.length === 1` is the `consumes: 1` mutant; 2 is `consumes: 0`.
    expect(claimed!.rest).toHaveLength(0);
  });

  test('⚠️ WITHOUT a ctx the pair declines — the bag would be unreachable', () => {
    /*
     * 🔑 The arm needs the bucket, so no ctx means no fusion. ⚠️ It must DECLINE to the element pick
     * (leaving both steps in `rest`) rather than consume them and drop the bag.
     */
    const g = armed(rowsOf);
    const claimed = hopValuesCsr(rowsOf(), g);

    expect(claimed).not.toBeUndefined();
    expect(claimed!.rest).toHaveLength(2);
  });

  test('⚠️ a bag with NO `values` after it keeps the old route', () => {
    const bagOnly = () => traversal(V(), out('E'), store('x'));
    const g = armed(bagOnly);
    const claimed = hopValuesCsr(bagOnly(), g, ctxOf());

    expect(claimed).not.toBeUndefined();
    // The bag step stays in `rest` for the residual dispatch — `consumes: 0`.
    expect(claimed!.rest).toHaveLength(1);
  });

  test('⚠️ a plain `values` still consumes exactly ONE step', () => {
    /*
     * The pre-existing arm, asserted so widening `consumes` cannot quietly change it.
     */
    const g = armed(refOf);
    const claimed = hopValuesCsr(refOf(), g, ctxOf());

    expect(claimed).not.toBeUndefined();
    expect(claimed!.rest).toHaveLength(0);
  });
});
