import { describe, expect, test } from 'bun:test';

/**
 * The ANSWERS `dedupedHopChainCount` produces — item 1855.
 *
 * `distinctHopCount` answered ONE hop from an index key count; two hops reached nothing and fell
 * to the traverser pipeline, a **398x** cliff (0.64 ms against 254.62) for four times the paths.
 * The new rung expands a SET per level instead of enumerating paths.
 *
 * THE ORACLE IS ENUMERATE-THEN-DEDUPE-IN-JS, not another engine route. `toArray` of the same
 * hops without the `dedupe`/`count` gives every endpoint the traverser would emit; putting those
 * in a `Set` and taking its size is the definition of the answer, computed outside the engine. A
 * second engine route could share a mistake with the first; this cannot.
 *
 * THE FIXTURES ARE CHOSEN FOR WHERE A LEVEL-BY-LEVEL SET CAN GO WRONG: a self-loop (a vertex
 * reaching itself, so the frontier must not grow or shrink wrongly), two disjoint cycles (a
 * frontier that revisits), a chain longer than the hop count (where the answer SHRINKS with
 * depth), a star (many sources, one target) and a mixed-type graph (where only some edges count).
 * A uniform random graph would make almost any implementation agree.
 */
import { Graph } from '@lenke/core';

import { V, count, dedupe, hasLabel, inE, in_ as inV, out, toArray, traversal } from '../index.js';
import { countShortcut } from './count-shortcut.js';

type Edge = readonly [from: string, to: string, label?: string];

const build = (edges: readonly Edge[]): Graph => {
  const g = new Graph();
  const ids = new Set<string>();

  for (const [f, t] of edges) {
    ids.add(f);
    ids.add(t);
  }

  for (const id of ids) {
    g.addVertex({ id, labels: ['T'], properties: {} });
  }

  let n = 0;

  for (const [f, t, label] of edges) {
    const from = g.getVertexById(f);
    const to = g.getVertexById(t);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id: `e${n}`, from, to, labels: [label ?? 'E'] });
    n += 1;
  }

  return g;
};

const FIXTURES: Record<string, readonly Edge[]> = {
  'self-loop alone': [['x', 'x']],
  'self-loop plus a tail': [
    ['x', 'x'],
    ['x', 'y'],
  ],
  'two disjoint cycles': [
    ['a', 'b'],
    ['b', 'a'],
    ['c', 'd'],
    ['d', 'c'],
  ],
  'chain shorter than the walk': [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
  ],
  'star, many sources one target': [
    ['a', 'z'],
    ['b', 'z'],
    ['c', 'z'],
  ],
  'mixed types': [
    ['a', 'b', 'E'],
    ['b', 'c', 'F'],
    ['a', 'c', 'E'],
    ['c', 'a', 'E'],
  ],
  'diamond with a dead end': [
    ['a', 'b'],
    ['a', 'c'],
    ['b', 'd'],
    ['c', 'd'],
    ['d', 'e'],
    ['q', 'q'],
  ],
};

const hops = (k: number, step: () => ReturnType<typeof out>): ReturnType<typeof out>[] =>
  Array.from({ length: k }, step);

describe('a deduped K-hop count', () => {
  /**
   * EVERY STEP VARIANT ACROSS EVERY FIXTURE, and the cross product is the point rather than
   * thoroughness for its own sake. The walk branches on DIRECTION (which adjacency box, which edge
   * endpoint) and on TYPED-vs-UNTYPED (one bucket or all), so there are four cells — and a mutant
   * that always took `e.to` inside the UNTYPED branch survived a version of this file that
   * exercised untyped-`in` on ONE fixture. On that fixture the wrong answer coincides with the
   * right one; on the star it does not (0 against 1). One fixture cannot test a branch.
   */
  const VARIANTS: Record<string, () => ReturnType<typeof out>> = {
    'out typed': () => out('E'),
    'out untyped': () => out(),
    'in typed': () => inV('E'),
    'in untyped': () => inV(),
  };

  test('agrees with enumerate-then-dedupe at every depth, fixture and direction', () => {
    for (const [name, edges] of Object.entries(FIXTURES)) {
      const g = build(edges);

      for (const [vname, step] of Object.entries(VARIANTS)) {
        for (const k of [2, 3, 4, 5]) {
          const rung = toArray(traversal(V(), ...hops(k, step), dedupe(), count()), g);
          const oracle = new Set(toArray(traversal(V(), ...hops(k, step)), g)).size;
          const where = `${name} / ${vname} / k=${k}`;

          expect(`${where}: ${String(rung[0])}`).toBe(`${where}: ${String(oracle)}`);
        }
      }
    }
  });

  /** The UNTYPED hop reads every bucket; the typed one reads only its own. */
  test('an untyped hop and a typed one each agree with their own oracle', () => {
    const g = build(FIXTURES['mixed types']);

    for (const k of [2, 3]) {
      const untypedRung = toArray(traversal(V(), ...hops(k, () => out()), dedupe(), count()), g);
      const untypedOracle = new Set(toArray(traversal(V(), ...hops(k, () => out())), g)).size;

      expect(untypedRung[0]).toBe(untypedOracle);

      const typedRung = toArray(traversal(V(), ...hops(k, () => out('F')), dedupe(), count()), g);
      const typedOracle = new Set(toArray(traversal(V(), ...hops(k, () => out('F'))), g)).size;

      expect(typedRung[0]).toBe(typedOracle);

      /**
       * UNTYPED *AND* INCOMING, which is a FOURTH combination and not a flourish: the walk has
       * a separate branch for "no labels" and a separate endpoint choice for `in`, so untyped-out,
       * typed-out and typed-in between them leave one cell untested. A mutant that always took
       * `e.to` inside the untyped branch survived until this case existed.
       */
      const inUntypedRung = toArray(traversal(V(), ...hops(k, () => inV()), dedupe(), count()), g);
      const inUntypedOracle = new Set(toArray(traversal(V(), ...hops(k, () => inV())), g)).size;

      expect(inUntypedRung[0]).toBe(inUntypedOracle);
    }
  });

  /**
   * A WALK THAT DIES OUT MUST ANSWER ZERO, not fall back to something non-empty. The chain
   * fixture has no path of length 4, so the frontier empties and the early return is exercised.
   */
  test('a walk with no paths of that length answers zero', () => {
    const g = build(FIXTURES['chain shorter than the walk']);

    expect(toArray(traversal(V(), ...hops(4, () => out('E')), dedupe(), count()), g)).toEqual([0]);
    expect(toArray(traversal(V(), ...hops(9, () => out('E')), dedupe(), count()), g)).toEqual([0]);
  });

  /**
   * THE `in` DIRECTION READS THE OTHER ADJACENCY BOX AND THE OTHER EDGE ENDPOINT, so it needs
   * its own check — and the FIRST version of this test did not give it one: it called `out('E')`
   * in both arms while claiming to test `in`. A mutant that always took `e.to`, which is wrong for
   * every `in` hop, SURVIVED it. The fixtures are directed and asymmetric, so `in` and `out`
   * genuinely differ here.
   */
  test('the IN direction agrees too', () => {
    for (const [name, edges] of Object.entries(FIXTURES)) {
      const g = build(edges);

      for (const k of [2, 3]) {
        const rung = toArray(traversal(V(), ...hops(k, () => inV('E')), dedupe(), count()), g);
        const oracle = new Set(toArray(traversal(V(), ...hops(k, () => inV('E'))), g)).size;

        expect(`${name} k=${k}: ${String(rung[0])}`).toBe(`${name} k=${k}: ${String(oracle)}`);
      }
    }
  });

  /** A MIXED chain — one `out` then one `in` — exercises both boxes in a single plan. */
  test('a mixed out/in chain agrees', () => {
    for (const edges of Object.values(FIXTURES)) {
      const g = build(edges);
      const rung = toArray(traversal(V(), out('E'), inV('E'), dedupe(), count()), g);
      const oracle = new Set(toArray(traversal(V(), out('E'), inV('E')), g)).size;

      expect(rung[0]).toBe(oracle);
    }
  });
});

describe('the deduped K-hop count declines what it must', () => {
  /**
   * THE REFUSALS ARE ASSERTED BY ROUTE, through `countShortcut` directly, because declining is
   * ANSWER-EQUIVALENT: the pipeline answers the same thing more slowly, so no value test can tell
   * a refusal from an acceptance. The sibling file makes the same move for the same reason.
   *
   * AND THE ANSWER IS CHECKED TOO, against the enumerate-then-dedupe oracle where the shape has
   * one — except for `dedupe().by(…)`, whose partitioning is its own question and is deliberately
   * NOT asserted here: a guess about it (that keying on `id` matches the element-wise dedupe) was
   * written first and was simply wrong, which is why the refusal is what this file pins.
   */
  const claimed = (plan: Parameters<typeof toArray>[0], g: Graph): number | undefined =>
    countShortcut(plan, g);

  test('a by-modulated or label-scoped dedupe is refused', () => {
    const g = build(FIXTURES['diamond with a dead end']);

    expect(
      claimed(traversal(V(), out('E'), out('E'), dedupe().by('id'), count()), g),
    ).toBeUndefined();
    expect(claimed(traversal(V(), out('E'), out('E'), dedupe('a'), count()), g)).toBeUndefined();
  });

  /** A vertex FILTER between the hops is not a hop; the expansion must not treat it as one. */
  test('a filter between the hops is refused, and the pipeline still answers', () => {
    const g = build(FIXTURES['two disjoint cycles']);
    const plan = traversal(V(), out('E'), hasLabel('T'), out('E'), dedupe(), count());

    expect(claimed(plan, g)).toBeUndefined();
    expect(toArray(plan, g)[0]).toBe(
      new Set(toArray(traversal(V(), out('E'), hasLabel('T'), out('E')), g)).size,
    );
  });

  /** An EDGE step in the chain is not a vertex hop. */
  test('an edge step in the chain is refused, and the pipeline still answers', () => {
    const g = build(FIXTURES['diamond with a dead end']);
    const plan = traversal(V(), out('E'), inE('E'), dedupe(), count());

    expect(claimed(plan, g)).toBeUndefined();
    expect(toArray(plan, g)[0]).toBe(new Set(toArray(traversal(V(), out('E'), inE('E')), g)).size);
  });

  /** One hop keeps its own rung, which is cheaper than a set expansion at that width. */
  test('one hop still goes to its own closed form', () => {
    const g = build(FIXTURES['star, many sources one target']);

    expect(claimed(traversal(V(), out('E'), dedupe(), count()), g)).toBe(1);
  });
});
