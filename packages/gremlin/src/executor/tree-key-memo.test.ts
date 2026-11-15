import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { planMutates } from '../ast.js';
import { V, out, path, property, toArray, traversal, tree, values } from '../index.js';
import { newContext } from './runtime.js';

/**
 * `tree()`'s canonical key memoized per element (item 1922) — **1013.61 -> 547.01 ms, 1.85x**, on
 * the Gremlin surface's largest shape.
 *
 * `treeKey` is `JSON.stringify(node.toJSON())`, the byte-identity contract with the Rust engine, and
 * a 600,000-row two-element path calls it **1,200,000 times over only 200,000 distinct vertices**.
 * Measured at 200,000 vertices / 800,000 edges, with `tree().by(k)` — the same shape with `treeKey`
 * skipped — as the control:
 *
 *     tree()         1013.61 -> 547.01 ms   ⬅ 1.85x
 *     tree().by(k)    269.67 -> 267.90       flat, never calls treeKey
 *     path()            8.66                 the same 600,000 paths, no keys at all
 *
 * ⚠️⚠️ THE MEMO IS GATED ON A CORRECTNESS CONDITION, NOT A TUNING KNOB, and the gate is the reason
 * this file exists. The stream is pulled LAZILY, so a mutation step upstream of `tree()` runs
 * INTERLEAVED with the tree insertion — an element can be keyed, then mutated, then keyed again, and
 * the two keys legitimately differ. A memo would answer from the stale side, which native does not.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: {} });
  // ⚠️ `b` IS BOTH A FAR END (of e1) AND A NEAR END (of e2), so it is keyed TWICE in one build.
  // That alone does NOT make a stale memo observable — see `cyclic()` below for the shape that does.

  return g;
};

/**
 * The tree built OUTSIDE the engine, from `path()`'s own output.
 *
 * ⚠️ THIS IS THE ORACLE AND IT MUST NOT SHARE CODE WITH THE SUBJECT. `tree()` and this differ in
 * every respect except the key function's definition, which is the contract (`toJSON()` stringified)
 * rather than an implementation detail — so a memo that returned a wrong key fails here, and so
 * would a tree that nested wrongly.
 */
const oracleTree = (paths: readonly unknown[]): Record<string, unknown> => {
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const p of paths) {
    let cursor = root;

    for (const node of p as unknown[]) {
      const key = JSON.stringify((node as Vertex).toJSON());
      let next = cursor[key] as Record<string, unknown> | undefined;

      if (next === undefined) {
        next = Object.create(null) as Record<string, unknown>;
        cursor[key] = next;
      }

      cursor = next;
    }
  }

  return root;
};

/**
 * ⚠️ A CYCLE, which is what makes a stale memo OBSERVABLE. On an acyclic chain a mutation step
 * upstream of `tree()` always reaches an element before its first keying, so a memo stores the
 * already-mutated key and answers identically. Here `a` is keyed clean in the first traverser and
 * again, after its own mutation, in the last.
 */
const cyclic = (): Graph => {
  const g = fixture();
  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e3', from: vx('c'), to: vx('a'), labels: ['E'], properties: {} });

  return g;
};

describe('the tree key memo', () => {
  it('builds the same tree an external oracle does', () => {
    const g = fixture();
    const [built] = toArray(traversal(V(), out('E'), tree()), g);
    const paths = toArray(traversal(V(), out('E'), path()), g);

    // Compared as JSON, which is what the byte-identity contract is about.
    expect(JSON.stringify(built)).toBe(JSON.stringify(oracleTree(paths)));
  });

  it('and the keys really are the canonical rendering, spelled out', () => {
    const g = fixture();
    const [built] = toArray(traversal(V(), out('E'), tree()), g);
    const a = g.getVertexById('a') as Vertex;
    const b = g.getVertexById('b') as Vertex;
    const keyA = JSON.stringify(a.toJSON());
    const keyB = JSON.stringify(b.toJSON());
    const top = built as Record<string, unknown>;

    // Two top-level entries (a and b are the near ends), and a's child is b.
    expect(Object.keys(top).sort()).toStrictEqual([keyA, keyB].sort());
    expect(Object.keys(top[keyA] as Record<string, unknown>)).toStrictEqual([keyB]);
  });

  it('a deeper path nests one level per element', () => {
    const g = fixture();
    const [built] = toArray(traversal(V(), out('E'), out('E'), tree()), g);
    const paths = toArray(traversal(V(), out('E'), out('E'), path()), g);

    expect(JSON.stringify(built)).toBe(JSON.stringify(oracleTree(paths)));
  });

  /**
   * ⚠️ A `by(...)` MODULATOR BYPASSES `treeKey` ENTIRELY, so the memo must not touch it — the keys
   * are the modulator's stringified values, not canonical renderings.
   */
  it('a by() modulator keys by the modulator value, not the element', () => {
    const g = fixture();
    const [built] = toArray(traversal(V(), out('E'), tree().by('n')), g);

    expect(JSON.stringify(built)).toBe(JSON.stringify({ a: { b: {} }, b: { c: {} } }));
  });

  /**
   * ⚠️ A SCALAR PATH POSITION IS NOT MEMOIZED, by design: it stringifies in one operation, so a memo
   * entry per distinct value would be the cost it was meant to remove. The answer must be unchanged.
   */
  it('a scalar in the path still keys by String(node)', () => {
    const g = fixture();
    const [built] = toArray(traversal(V(), out('E'), values('n'), tree()), g);
    const b = g.getVertexById('b') as Vertex;
    const top = built as Record<string, unknown>;
    const first = top[JSON.stringify((g.getVertexById('a') as Vertex).toJSON())] as Record<
      string,
      unknown
    >;

    // [a, b, 'b'] — the vertex keys are canonical, the scalar is plain.
    expect(Object.keys(first)).toStrictEqual([JSON.stringify(b.toJSON())]);
    expect(Object.keys(first[JSON.stringify(b.toJSON())] as Record<string, unknown>)).toStrictEqual(
      ['b'],
    );
  });
});

/**
 * ⚠️ THE GATE. `planMutates` is what turns the memo off, and these are the shapes it must catch —
 * a missed one is a WRONG ANSWER rather than a lost optimisation, which is why the consumer defaults
 * to "not stable" and only this set turns it on.
 */
describe('the mutation gate', () => {
  it('spots a mutation step at the top level', () => {
    expect(planMutates(traversal(V(), out('E'), tree()))).toBe(false);
    expect(planMutates(traversal(V(), property('z', 1), out('E'), tree()))).toBe(true);
    expect(planMutates(traversal(V(), out('E'), property('z', 2), tree()))).toBe(true);
  });

  /**
   * ⚠️ AND INSIDE A SUB-PLAN, which is why `planMutates` recurses: a mutation in a `union` arm
   * changes elements exactly as a top-level one does, and `SUBPLAN_FIELDS` does not include the
   * `plans` array or `bys`, so both are walked explicitly.
   */
  it('spots a mutation nested in a sub-plan', async () => {
    const { union, optional, where } = await import('../index.js');

    expect(
      planMutates(traversal(V(), union(traversal(property('z', 1)), traversal(out('E'))))),
    ).toBe(true);
    expect(planMutates(traversal(V(), optional(traversal(property('z', 1)))))).toBe(true);
    expect(planMutates(traversal(V(), where(traversal(out('E')))))).toBe(false);
    expect(planMutates(traversal(V(), union(traversal(out('E')), traversal(out('F')))))).toBe(
      false,
    );
  });

  /**
   * ⚠️ THE INTERLEAVED CASE, PINNED. `treekey-mutation-probe-1922.mjs` found
   * `V().out(E).property(z,2).tree()` keying ONE of its two top-level entries WITH the new property
   * and the other without — the same element keyed on both sides of its own mutation. With the gate
   * the memo is off and that stays true; a memo would collapse them.
   */
  it('a mutation upstream of tree() keeps the straddled keys', () => {
    const g = cyclic();
    const [built] = toArray(traversal(V(), out('E'), property('z', 2), tree()), g);
    const top = built as Record<string, unknown>;
    const a = g.getVertexById('a') as Vertex;
    const c = g.getVertexById('c') as Vertex;

    /*
     * ⚠️⚠️ THIS IS THE ASSERTION FOUR GATE MUTANTS SURVIVED WITHOUT, and the first version of it
     * could not have caught them. It asserted "1 of 2 top-level keys mentions z" on an acyclic
     * `a->b, b->c` fixture — but there the property runs on the FAR end BEFORE `tree` keys it, so
     * every element is mutated before its FIRST keying and a memo stores the already-mutated key.
     * Same answer either way; the "1 of 2" was only "`a` was never mutated".
     *
     * 🔑 THE DISCRIMINATING SHAPE NEEDS A CYCLE, so an element is keyed CLEAN, then mutated, then
     * keyed AGAIN. Traverser order is `[a,b]`, `[b,c]`, `[c,a]`: `a` is keyed at the TOP in the
     * first and, after `property` mutates it in the third, keyed again UNDER `c`.
     *
     * ⚠️ AND IT IS A NESTED KEY, NOT A TOP-LEVEL ONE — the second thing the first version missed.
     * Every vertex here has exactly one out-edge, so the top level is always three keys whatever
     * happens. `treememo-stale-probe-1922.mjs` printed the whole tree to find this.
     */
    const topKeyOfA = Object.keys(top).find((k) => k.includes('"id":"a"')) as string;
    const underC = top[Object.keys(top).find((k) => k.includes('"id":"c"')) as string] as Record<
      string,
      unknown
    >;
    const [nestedKeyOfA] = Object.keys(underC);

    // `a` keyed BEFORE its mutation: no `z`. Keyed again AFTER it: `z` present. A memo would hand
    // back the first key both times, collapsing these into one.
    expect(topKeyOfA.includes('"z"')).toBe(false);
    expect(nestedKeyOfA.includes('"z"')).toBe(true);
    expect(nestedKeyOfA).toBe(JSON.stringify(a.toJSON()));
    expect(nestedKeyOfA).not.toBe(topKeyOfA);
    // And `c` really is the parent, so the nesting is what the comment claims.
    expect(Object.keys(top).some((k) => k === JSON.stringify(c.toJSON()))).toBe(true);
  });

  /**
   * ⚠️ THE CONSERVATIVE DEFAULT IS THE WHOLE SAFETY STORY, so it is asserted rather than trusted: a
   * mutant flipping `newContext`'s `keysStable` default to `true` survived the first battery because
   * nothing looked at it. A context built without the flag — sub-plan evaluation, a hand-made call —
   * must never memoize.
   */
  it('newContext defaults keysStable to false, the safe value', () => {
    expect(newContext().keysStable).toBe(false);
    expect(newContext(true).keysStable).toBe(false);
    expect(newContext(true, true).keysStable).toBe(true);
  });
});
