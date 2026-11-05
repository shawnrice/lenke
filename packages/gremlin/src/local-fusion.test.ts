import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { effectivePlan, fuseLocal, run } from './executor.js';
import { V, count, dedupe, fold, inV, local, out, outE, pipe, values } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1479: `local(plan)` where every step of `plan` maps each traverser independently becomes
 * `plan` inlined, because `localStep` otherwise re-dispatches its sub-plan once per incoming
 * traverser. **19.95x** on `V().local(outE().inV()).values('k').count()` at 20,000 vertices, landing
 * exactly on a hand floor.
 *
 * ⚠️ THIS REWRITE CAN CHANGE ANSWERS IF THE ALLOWLIST IS WRONG, so the tests below are mostly about
 * what must NOT fuse. `local`'s whole purpose is per-traverser scoping: `local(out(E), count())`
 * counts EACH traverser's neighbours, and fusing it would count the whole stream once.
 *
 * ⚠️ `dedupe` IS THE TRAP. It sits in `ORDER_FREE_STEPS` — order-free is a different property from
 * local-transparent — but `local(out(E), dedupe())` dedupes WITHIN each traverser, so a vertex
 * reached from two different sources legitimately appears twice. Fusing it would collapse those.
 * It is deliberately absent from `LOCAL_TRANSPARENT_STEPS`.
 */

/** a -> b, a -> c, b -> c. `c` is reachable from BOTH a and b, which is what makes dedupe visible. */
const diamond = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['E'] });
  g.addEdge({ id: 'e3', from: b, to: c, labels: ['E'] });

  return g;
};

const out_ = (g: Graph, plan: Parameters<typeof run>[0]): unknown[] => [...run(plan, g)];

describe('a barrier inside local() must NOT fuse — it is why the step exists', () => {
  test('local(count()) counts EACH traverser, not the stream', () => {
    expect(out_(diamond(), traversal(V(), local(pipe(count()))))).toEqual([1, 1, 1]);
  });

  test('local(out(E), count()) gives a per-traverser degree, not a total', () => {
    // Fused, this would be a single 3.
    expect(out_(diamond(), traversal(V(), local(pipe(out('E'), count()))))).toEqual([2, 1, 0]);
  });

  test('local(out(E), fold()) folds per traverser, so there are three lists', () => {
    const rows = out_(diamond(), traversal(V(), local(pipe(out('E'), fold()))));

    expect(rows).toHaveLength(3);
    expect((rows[0] as unknown[]).length).toBe(2);
    expect((rows[2] as unknown[]).length).toBe(0);
  });

  test('local(out(E), dedupe()) dedupes WITHIN a traverser, so c survives twice', () => {
    const ids = out_(diamond(), traversal(V(), local(pipe(out('E'), dedupe())))).map(
      (v) => (v as { id: string }).id,
    );

    // From a: b, c. From b: c. Fused dedupe would drop the second c.
    expect(ids).toEqual(['b', 'c', 'c']);
  });
});

describe('a transparent local() fuses and answers identically', () => {
  test('local(outE(), inV()) equals the unwrapped chain', () => {
    const g = diamond();
    const wrapped = out_(g, traversal(V(), local(pipe(outE(), inV())), values('k')));
    const bare = out_(g, traversal(V(), outE(), inV(), values('k')));

    expect(wrapped).toEqual(bare);
    expect(wrapped).toEqual([2, 3, 3]);
  });

  test('local(out(E)) equals the unwrapped hop', () => {
    const g = diamond();

    expect(out_(g, traversal(V(), local(pipe(out('E'))), values('k')))).toEqual(
      out_(g, traversal(V(), out('E'), values('k'))),
    );
  });

  test('a transparent local() followed by count() agrees with the bare chain', () => {
    const g = diamond();

    expect(out_(g, traversal(V(), local(pipe(outE(), inV())), count()))).toEqual(
      out_(g, traversal(V(), outE(), inV(), count())),
    );
  });
});

describe('the rewrite itself, and that it is WIRED', () => {
  test('fuseLocal inlines a transparent sub-plan', () => {
    const plan = traversal(V(), local(pipe(outE(), inV())), count());
    const fused = fuseLocal(plan);

    expect(fused.steps.map((s) => s.kind)).toEqual(['V', 'outE', 'inV', 'count']);
  });

  test('fuseLocal leaves a barrier-bearing sub-plan alone', () => {
    const plan = traversal(V(), local(pipe(out('E'), count())));

    expect(fuseLocal(plan).steps.map((s) => s.kind)).toEqual(['V', 'local']);
  });

  test('fuseLocal returns the SAME plan object when nothing changes', () => {
    const plan = traversal(V(), out('E'), count());

    expect(fuseLocal(plan)).toBe(plan);
  });

  /**
   * ⚠️ THE WIRING, not just the rewrite. A mutant that stops CALLING a rewrite answers identically
   * by the slow route, so testing `fuseLocal` alone would leave it unwired and undetected — the
   * shape items 1303 and 1447 paid for.
   */
  test('effectivePlan APPLIES fuseLocal', () => {
    const plan = traversal(V(), local(pipe(outE(), inV())), count());
    const eff = effectivePlan(plan, diamond(), false);

    expect(eff.steps.some((s) => s.kind === 'local')).toBe(false);
  });

  test('effectivePlan leaves local() in place when the plan tracks path', () => {
    const plan = traversal(V(), local(pipe(outE(), inV())), count());

    expect(effectivePlan(plan, diamond(), true).steps.some((s) => s.kind === 'local')).toBe(true);
  });
});
