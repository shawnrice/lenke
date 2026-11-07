/**
 * `effectivePlan`'s per-plan memo of its graph-free prefix (item 1647): what it caches, what it
 * deliberately does NOT, the reset, and the serialization its key shape was chosen to preserve.
 *
 * ⚠️ WHY THESE ARE THE TESTS. A cache on an answer-equivalent rewrite is invisible to every
 * differential test by construction (`perf-gate-needs-its-own-test`): a correct cache and no cache
 * at all return the same rows, so the suite that guards answers cannot see this code. What CAN go
 * wrong is what the cache is allowed to span, and there the failure is a wrong answer:
 *
 *   - cache a GRAPH-DEPENDENT pass and the same plan serves graph A's rewrite for graph B, or
 *     serves a pre-mutation rewrite after the write that invalidated it;
 *   - inherit the slot through `rewritten`'s spread and a rewritten plan is handed back as the
 *     answer for the plan it was rewritten FROM.
 *
 * ⚠️⚠️ THE FIRST OF THOSE IS NOT HYPOTHETICAL, AND IT IS WHY THIS CACHE STOPS WHERE IT DOES. Item
 * 1646 designed a whole-chain cache keyed on `(graph, graph.version)` and recorded that `Graph`
 * already carried the counter it needed. It does not: `version` and `epoch(name)` are REACTIVE
 * counters that advance when the mutation queue DRAINS, on a microtask. `addVertex()` followed by
 * `graph.version` reads the OLD value, so every read in the same synchronous block as a write would
 * have hit a stale entry — and for `dropVacuousLabels`, which reads the graph's label counts, that
 * is a dropped filter against a graph where it is no longer vacuous. `the drain is asynchronous`
 * below pins that property of `Graph` so the design cannot be re-derived from the wrong premise.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { EFF_PREFIX } from './ast.js';
import type { Plan } from './ast.js';
import { effectivePlan, fuseLocal, toArray } from './executor.js';
import { V, both, count, hasLabel, in_, local, out, traversal, union } from './index.js';

/** Every vertex carries `P`, so `hasLabel('P')` excludes nothing and `dropVacuousLabels` drops it. */
const allP = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  return g;
};

/** Same vertex count and the same number of writes, but `P` is on only one of the two. */
const halfP = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  g.addVertex({ id: 'b', labels: ['Q'], properties: { k: 2 } });

  return g;
};

const kindsOf = (plan: Plan, graph: Graph): string[] =>
  effectivePlan(plan, graph, false).steps.map((s) => s.kind);

describe('Graph has no synchronous mutation counter', () => {
  /**
   * ⚠️ THE PREMISE ITEM 1646 GOT WRONG, pinned as a property of `Graph` rather than left as a
   * comment. If this test ever fails because the counters became synchronous, the whole-chain cache
   * that item priced becomes available — and until then it is a wrong answer.
   */
  test('version and epoch advance only on the drain', async () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: {} });

    expect(g.version).toBe(0);
    expect(g.epoch('P')).toBe(0);
    // The one counter that IS synchronous, and not enough on its own: a label's distribution can
    // change at a constant vertex count.
    expect(g.vertexCount).toBe(1);

    await Promise.resolve();

    expect(g.version).toBe(1);
    expect(g.epoch('P')).toBe(1);
  });

  /**
   * And the precondition that makes a version-only key wrong twice over: two graphs built with the
   * same number of writes carry the same version, so such a key would hit on the wrong graph.
   */
  test('two differently-labelled graphs share a version', () => {
    expect(allP().version).toBe(halfP().version);
  });
});

describe('the graph-dependent passes are NOT cached', () => {
  test('the same plan rewrites differently against each graph, in both orders', () => {
    const plan = traversal(V(), hasLabel('P'), count());

    expect(kindsOf(plan, allP())).toEqual(['V', 'count']);
    expect(kindsOf(plan, halfP())).toEqual(['V', 'hasLabel', 'count']);
    // And back again on the SAME plan object, which now carries a populated prefix slot.
    expect(kindsOf(plan, allP())).toEqual(['V', 'count']);

    const reverse = traversal(V(), hasLabel('P'), count());

    expect(kindsOf(reverse, halfP())).toEqual(['V', 'hasLabel', 'count']);
    expect(kindsOf(reverse, allP())).toEqual(['V', 'count']);
  });

  test('and the answers follow, alternating graphs on one plan', () => {
    const plan = traversal(V(), hasLabel('P'), count());
    const vacuous = allP();
    const selective = halfP();

    expect(toArray(plan, vacuous)).toEqual([2]);
    expect(toArray(plan, selective)).toEqual([1]);
    expect(toArray(plan, vacuous)).toEqual([2]);
    expect(toArray(plan, selective)).toEqual([1]);
  });

  /**
   * ⚠️ THE WRONG ANSWER A `version`-KEYED WHOLE-CHAIN CACHE PRODUCES, with no `await` anywhere:
   * every read here happens in the same synchronous block as the write before it, which is exactly
   * where the reactive counter has not moved yet.
   */
  test('a write immediately before the read is seen — no drain in between', () => {
    const g = allP();
    const plan = traversal(V(), hasLabel('P'), count());

    expect(kindsOf(plan, g)).toEqual(['V', 'count']);
    expect(toArray(plan, g)).toEqual([2]);

    g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

    expect(kindsOf(plan, g)).toEqual(['V', 'hasLabel', 'count']);
    expect(toArray(plan, g)).toEqual([2]);

    g.addVertex({ id: 'd', labels: ['P'], properties: { k: 4 } });

    expect(toArray(plan, g)).toEqual([3]);
  });
});

describe('the graph-free prefix IS cached', () => {
  test('a hit returns the identical prefix object', () => {
    const plan = traversal(V(), union(out('T'), in_('T')), count());

    expect(plan[EFF_PREFIX]).toBeUndefined();

    const first = effectivePlan(plan, halfP(), false);

    expect(plan[EFF_PREFIX]).toBeDefined();
    expect(effectivePlan(plan, halfP(), false)).toBe(first);
  });

  /** The cached pass that item 1645 priced at 94.5 ns: `union(out, in)` collapses to `both`. */
  test('it holds the union collapse, and the collapse is what the union spelling runs', () => {
    const plan = traversal(V(), union(out('T'), in_('T')), count());

    expect(kindsOf(plan, halfP())).toEqual(['V', 'both', 'count']);
    expect(plan[EFF_PREFIX]?.steps.map((s) => s.kind)).toEqual(['V', 'both', 'count']);
    // Which is the plan the `both` spelling builds outright.
    expect(traversal(V(), both('T'), count()).steps.map((s) => s.kind)).toEqual([
      'V',
      'both',
      'count',
    ]);
  });

  /**
   * ⚠️ THE MUTANT THIS KILLS is `rewritten` inheriting the slot through `...plan`, which object
   * spread DOES copy for enumerable own symbol properties. A rewritten plan is a different step
   * list, so an entry on it answers a different question.
   */
  test('a rewritten plan carries NO inherited cache', () => {
    const plan = traversal(V(), union(out('T'), in_('T')), count());
    const prefix = effectivePlan(plan, halfP(), false);

    expect(prefix).not.toBe(plan);
    expect(prefix[EFF_PREFIX]).toBeUndefined();
  });

  /**
   * ⚠️ THE ASSERTION ABOVE IS NOT ENOUGH, AND A MUTANT PROVED IT. Deleting `rewritten`'s reset
   * leaves the whole suite green, because every `rewritten` call the chain makes today happens
   * BEFORE the slot is written — so the inherited value is `undefined` either way and the reset is
   * defensive rather than load-bearing. This test reaches the hazard the reset exists for: a pass
   * called on a plan that is ALREADY cached, which `fuseLocal` can be, since it is exported.
   */
  test('a pass called on an already-cached plan does not propagate the slot', () => {
    const plan = traversal(V(), local(out('T')), count());

    effectivePlan(plan, halfP(), false);

    expect(plan[EFF_PREFIX]).toBeDefined();

    const refused = fuseLocal(plan);

    expect(refused).not.toBe(plan);
    expect(refused[EFF_PREFIX]).toBeUndefined();
  });

  test('tracksPath returns the plan unchanged and caches nothing', () => {
    const g = allP();
    const plan = traversal(V(), hasLabel('P'), count());

    expect(effectivePlan(plan, g, true)).toBe(plan);
    expect(plan[EFF_PREFIX]).toBeUndefined();

    // And the un-cached call did not poison the real one.
    expect(kindsOf(plan, g)).toEqual(['V', 'count']);
  });

  test('a plan no prefix pass rewrites caches ITSELF, which is a cycle', () => {
    const plan = traversal(V(), out('T'), count());

    expect(effectivePlan(plan, allP(), false)).toBe(plan);
    expect(plan[EFF_PREFIX]).toBe(plan);
  });
});

describe('a cached plan is still serializable', () => {
  /**
   * ⚠️ THIS IS WHY THE SLOT IS SYMBOL-KEYED. `serialize.ts` does `JSON.stringify(plan)` as a public
   * API, and the self-caching case above puts a CYCLE in the slot — which would make
   * `JSON.stringify` throw outright if the key were a plain string.
   */
  test('JSON round-trips after the cycle case', () => {
    const plan = traversal(V(), out('T'), count());

    effectivePlan(plan, allP(), false);

    // The JSON round-trip IS the property under test: `serialize.ts` stringifies a plan, and
    // `structuredClone` would not exercise that path (it drops symbol-keyed slots for its own
    // reasons, rather than because JSON ignores symbol keys).
    // eslint-disable-next-line unicorn/prefer-structured-clone -- see above
    const round = JSON.parse(JSON.stringify(plan)) as Plan;

    expect(round.steps.map((s) => s.kind)).toEqual(['V', 'out', 'count']);
    expect(Object.keys(round)).toEqual(['steps', 'readsPath', 'kinds', 'mayFault']);
  });

  test('and after the rewritten case, whose slot holds a different plan', () => {
    const plan = traversal(V(), union(out('T'), in_('T')), count());

    effectivePlan(plan, allP(), false);

    // The JSON round-trip IS the property under test: `serialize.ts` stringifies a plan, and
    // `structuredClone` would not exercise that path (it drops symbol-keyed slots for its own
    // reasons, rather than because JSON ignores symbol keys).
    // eslint-disable-next-line unicorn/prefer-structured-clone -- see above
    const round = JSON.parse(JSON.stringify(plan)) as Plan;

    expect(Object.keys(round)).toEqual(['steps', 'readsPath', 'kinds', 'mayFault']);
    expect(round.steps.map((s) => s.kind)).toEqual(['V', 'union', 'count']);
  });
});
