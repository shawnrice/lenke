/*
 * Item 2113 — `V().store(k).values(key)` takes item 2078's fused scan walk, and the bag is right.
 *
 * ⚠️⚠️ **THE BAG IS THE WHOLE POINT, AND IT IS WHAT A ROW TEST CANNOT SEE.** Item 2112 learned this the
 * hard way: five tests covering every consumption pattern through the public API all SURVIVED mutants
 * that deleted the bag push, because a bare bag step has no public reader. So every test here asserts
 * `ctx.sideEffects` contents directly, and the rows are checked against the generic path separately.
 *
 * 🔑 THE BAG HOLDS VERTICES, NOT VALUES — the bag step sits BEFORE the projection. Item 2078's own
 * header: "a vertex lacking the projected key is BAGGED but not EMITTED", so the bag is NOT the row set
 * and a fixture with such a vertex is what proves it.
 */
import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { store, toArray, traversal, V, values } from '../index.js';
import { scanBagValuesShortcut } from './node-values.js';

/**
 * Six vertices, TWO of which lack `n`.
 *
 * ⚠️ THE MISSING KEY IS LOAD-BEARING: it is the only thing that makes "the bag is not the row set"
 * observable. A fixture where every vertex carries the key would pass a bag check that returned the rows.
 */
const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: i % 3 === 2 ? { other: i } : { n: i * 10 },
    });
  }

  return g;
};

const ctxOf = () => ({ sideEffects: new Map<string, unknown[]>() });
const plan = () => traversal(V(), store('x'), values('n'));
const ids = (bag: readonly unknown[] | undefined): string[] =>
  (bag ?? []).map((v) => (v as Vertex).id);

describe('V().store(k).values(key) is fused (item 2113)', () => {
  test('🔑 the ROWS match the generic path, and skip the keyless vertices', () => {
    const g = build();

    // Four of six carry `n`: v0, v1, v3, v4.
    expect(toArray(plan(), g)).toStrictEqual([0, 10, 30, 40]);
  });

  test('⚠️⚠️ drain only — the bag holds EVERY VERTEX, including the two with no `n`', () => {
    const g = build();
    const ctx = ctxOf();
    const rows = scanBagValuesShortcut(plan(), g, ctx as never)!.drain!();

    expect(rows).toStrictEqual([0, 10, 30, 40]);
    // 🔑 SIX bagged, FOUR emitted — the bag is not the row set.
    expect(ids(ctx.sideEffects.get('x'))).toStrictEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  });

  test('⚠️ iterate fully — the same bag', () => {
    const g = build();
    const ctx = ctxOf();
    const got = [...scanBagValuesShortcut(plan(), g, ctx as never)!];

    expect(got).toStrictEqual([0, 10, 30, 40]);
    expect(ids(ctx.sideEffects.get('x'))).toStrictEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  });

  test('⚠️⚠️ iterate PART-WAY — the bag holds only the vertices the walk VISITED', () => {
    /*
     * 🔑 THE ASSERTION ITEM 2078's REFUSAL OF `store` WAS NAMED FOR. Pulling two rows visits v0, v1 and
     * then v2 (which has no `n`, so the walk must advance past it to produce the second row) — so the bag
     * holds exactly what was walked, not the whole graph.
     *
     * ⚠️ An EAGER arm would have banked all six here, which is precisely what was refused.
     */
    const g = build();
    const ctx = ctxOf();
    const pulled: unknown[] = [];

    for (const v of scanBagValuesShortcut(plan(), g, ctx as never)!) {
      pulled.push(v);

      if (pulled.length >= 2) {
        break;
      }
    }

    expect(pulled).toStrictEqual([0, 10]);
    // v0 and v1 produced the two rows; nothing past them has been visited.
    expect(ids(ctx.sideEffects.get('x'))).toStrictEqual(['v0', 'v1']);
  });

  test('⚠️⚠️ part-way THEN drain — EVERY VERTEX EXACTLY ONCE, no doubling', () => {
    /*
     * 🔑 ITEM 2098's DEMONSTRATED HAZARD, in this fusion. `[Symbol.iterator]` used to be a FACTORY and
     * `drain` built a second generator, so the prefix was banked twice. One shared generator cannot
     * yield the same vertex twice.
     */
    const g = build();
    const ctx = ctxOf();
    const result = scanBagValuesShortcut(plan(), g, ctx as never)!;
    const pulled: unknown[] = [];

    for (const v of result) {
      pulled.push(v);

      if (pulled.length >= 2) {
        break;
      }
    }

    const rest = result.drain!();

    expect(pulled).toStrictEqual([0, 10]);
    expect(rest).toStrictEqual([30, 40]);
    // 🔑 SIX entries, each ONCE — not eight, and not two.
    expect(ids(ctx.sideEffects.get('x'))).toStrictEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  });

  test('⚠️ `aggregate` KEEPS the re-walkable result — this item changed only `store`', () => {
    /*
     * 🔑 `aggregate` is a collecting barrier, so a factory per consumer is correct for it and is what it
     * had. ⚠️ Asserted by iterating TWICE, which a single-pass result cannot do — so this fails if the
     * two kinds are ever given the same result by accident.
     */
    const g = build();
    const ctx = ctxOf();
    const agg = traversal(V(), store('x'), values('n'));
    const aggregated = scanBagValuesShortcut(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- the kind is swapped below
      {
        ...agg,
        steps: [agg.steps[0], { ...agg.steps[1], kind: 'aggregate' }, agg.steps[2]],
      } as never,
      g,
      ctx as never,
    )!;

    expect([...aggregated]).toStrictEqual([0, 10, 30, 40]);
    // ⚠️ A SECOND pass: re-walkable, so the rows come again (and the bag is banked again, by design).
    expect([...aggregated]).toStrictEqual([0, 10, 30, 40]);
  });

  test('⚠️ an EXISTING bag is appended to, not replaced', () => {
    const g = build();
    const ctx = ctxOf();

    ctx.sideEffects.set('x', ['prior']);
    scanBagValuesShortcut(plan(), g, ctx as never)!.drain!();

    expect(ctx.sideEffects.get('x')).toHaveLength(7);
    expect(ctx.sideEffects.get('x')![0]).toBe('prior');
  });
});
