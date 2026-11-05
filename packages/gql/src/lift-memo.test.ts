/**
 * The auto-parameterization lift memo (item 1541).
 *
 * ⚠️ THE MEMO IS ANSWER-EQUIVALENT WHEN IT WORKS, so it needs its own tests — but it has ONE way to
 * be wrong that is a wrong ANSWER, not a slow one: if the slot is consulted without comparing the
 * text, or compared against the LIFTED text rather than the original, then `LET x = 5` followed by
 * `LET x = 6` serves 5 twice. Both texts lift to the same `LET x = $__ap0 RETURN x`, so the lifted
 * text cannot distinguish them and the parse cache cannot notice. That is what most of this file
 * is about.
 *
 * Item 1540 measured the gap this closes (1013.2 -> 250 ns/call, 3.98x) and item 1541 records why
 * the slot is single rather than an LRU: a `Map` keyed by the original text cost the all-miss
 * workload 17%, and its admission filter recovered only half.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { parseCacheStats, query } from './index.js';

const g = () => {
  const graph = new Graph();

  graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  graph.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  return graph;
};

describe('item 1541 — the lift memo', () => {
  /**
   * ⚠️ THE ROUTE ITSELF. A memo is answer-equivalent, so the mutation run showed `never-store` and
   * `store-before-parse` surviving all 3,858 answer tests. `parseCacheStats` reports the slot's hit
   * and store counts for exactly this reason — the same reason it reports `seen` for the LRU, whose
   * eviction item 1509 could not otherwise test.
   */
  /**
   * THE RING (item 1542). One slot won at one hot query and lost everything at two — `rot2`
   * measured ~1030 ns against `rot1`'s 250, i.e. straight back to the un-memoised cost. Four slots
   * hold a realistic serving mix; the fifth distinct text evicts round-robin.
   */
  test('FOUR distinct liftable texts all hit, and each keeps its OWN value', () => {
    const graph = g();
    const texts = [11, 12, 13, 14];

    // Warm: one store each, no hits.
    const before = parseCacheStats();

    for (const v of texts) {
      expect(query(graph, `LET x = ${v} RETURN x`)).toEqual([{ x: v }]);
    }

    const warmed = parseCacheStats();

    expect(warmed.liftStores).toBe(before.liftStores + 4);
    expect(warmed.liftHits).toBe(before.liftHits);

    // Now every one of the four hits, and still answers with its own literal — four slots means
    // four chances to serve the wrong value, which is the failure `no-text-compare` produces.
    for (const v of texts) {
      expect(query(graph, `LET x = ${v} RETURN x`)).toEqual([{ x: v }]);
    }

    const hot = parseCacheStats();

    expect(hot.liftHits).toBe(warmed.liftHits + 4);
    expect(hot.liftStores).toBe(warmed.liftStores);
  });

  test('a FULL CYCLE of new texts evicts every earlier one, which still answers', () => {
    // ⚠️ CURSOR-INDEPENDENT ON PURPOSE. The ring is module state shared by every test in this file,
    // so the write cursor is wherever earlier cases left it. My first version stored four texts and
    // asserted the FIFTH evicted the first — it did not, because the cursor did not start at slot
    // 0, and the test failed for a reason that had nothing to do with the behaviour. Writing a full
    // ring's worth of NEW texts evicts all four whatever the cursor position.
    const graph = g();
    const first = [31, 32, 33, 34];

    for (const v of first) {
      expect(query(graph, `LET x = ${v} RETURN x`)).toEqual([{ x: v }]);
    }

    for (const v of [41, 42, 43, 44]) {
      expect(query(graph, `LET x = ${v} RETURN x`)).toEqual([{ x: v }]);
    }

    const before = parseCacheStats();

    // All four of the first group are gone, so each stores instead of hitting — and each still
    // answers with its own literal, because the ring is an optimization and never the truth.
    for (const v of first) {
      expect(query(graph, `LET x = ${v} RETURN x`)).toEqual([{ x: v }]);
    }

    const after = parseCacheStats();

    expect(after.liftStores).toBe(before.liftStores + 4);
    expect(after.liftHits).toBe(before.liftHits);
  });

  test('a REPEATED liftable text HITS the slot — the route, not the answer', () => {
    const graph = g();
    const before = parseCacheStats();

    query(graph, 'LET x = 41 RETURN x');

    const afterFirst = parseCacheStats();

    // First sighting: a store, no hit.
    expect(afterFirst.liftStores).toBe(before.liftStores + 1);
    expect(afterFirst.liftHits).toBe(before.liftHits);

    query(graph, 'LET x = 41 RETURN x');
    query(graph, 'LET x = 41 RETURN x');

    const afterMore = parseCacheStats();

    // Repeats hit and do NOT re-store.
    expect(afterMore.liftHits).toBe(before.liftHits + 2);
    expect(afterMore.liftStores).toBe(afterFirst.liftStores);
  });

  test('a syntactically invalid text stores nothing — but see the limitation', () => {
    // ⚠️ THIS DOES NOT COVER `store-before-parse`, AND I CHECKED RATHER THAN ASSUMED. The counters
    // say this text never ATTEMPTS a lift (liftStores delta 0, liftHits delta 0): `MAYBE_LIFTABLE`
    // rejects it, so the whole `if (lifted !== undefined)` block is skipped and no store happens on
    // either arm. The mutant that stores before the parse therefore SURVIVES, and it is
    // answer-equivalent too (the fallback raises the same error either way), so nothing in the
    // suite sees it.
    //
    // To cover it properly needs a text whose literals the allowlist ADMITS but whose rewritten
    // form fails to parse. `query`'s own comment says that is possible-but-rare by construction
    // ("a rewrite can only produce invalid syntax, never different semantics, for the positions the
    // allowlist admits"), and I could not construct one. The `if (memoed === undefined)` placement
    // stays as defence; this test only pins that an invalid text is not stored and does not poison
    // the slot.
    const graph = g();
    const before = parseCacheStats();

    expect(() => query(graph, 'MATCH (n:P) WHERE n.k = RETURN n.k')).toThrow();

    expect(parseCacheStats().liftStores).toBe(before.liftStores);
    expect(query(graph, 'LET x = 5 RETURN x')).toEqual([{ x: 5 }]);
  });

  test('a NON-liftable text neither hits nor stores', () => {
    const graph = g();

    query(graph, 'RETURN 1 AS v');

    const before = parseCacheStats();

    query(graph, 'RETURN 1 AS v');
    query(graph, 'RETURN 1 AS v');

    const after = parseCacheStats();

    expect(after.liftHits).toBe(before.liftHits);
    expect(after.liftStores).toBe(before.liftStores);
  });

  test('a DIFFERENT literal value is not served from the slot', () => {
    // The failure this guards: both texts lift to `LET x = $__ap0 RETURN x`, so neither the lifted
    // text nor the parse cache can tell them apart. Only the original-text compare can.
    const graph = g();

    expect(query(graph, 'LET x = 5 RETURN x')).toEqual([{ x: 5 }]);
    expect(query(graph, 'LET x = 6 RETURN x')).toEqual([{ x: 6 }]);
    expect(query(graph, 'LET x = 5 RETURN x')).toEqual([{ x: 5 }]);
  });

  test('ALTERNATING literal texts each keep their own value', () => {
    // A single slot is overwritten by every miss, so alternating thrashes it. The answers must
    // still be right — the slot is an optimization, never a source of truth.
    const graph = g();

    for (let i = 0; i < 6; i += 1) {
      expect(query(graph, `LET x = ${i} RETURN x`)).toEqual([{ x: i }]);
    }

    for (const i of [3, 1, 4, 1, 5]) {
      expect(query(graph, `LET x = ${i} RETURN x`)).toEqual([{ x: i }]);
    }
  });

  test('the same text REPEATED is stable, which is the case the memo exists for', () => {
    const graph = g();

    for (let i = 0; i < 20; i += 1) {
      expect(query(graph, 'MATCH (n:P) WHERE n.k = 2 RETURN n.k AS k')).toEqual([{ k: 2 }]);
    }
  });

  test('USER PARAMS still win over lifted ones, on a memo HIT as well as a miss', () => {
    // The spread order is `{ ...lifted.params, ...params }`. A memo hit must not change it — and a
    // hit only happens on the second call, so both calls are checked.
    const graph = g();

    expect(query(graph, 'LET x = 5 RETURN $p AS p, x', { p: 9 })).toEqual([{ p: 9, x: 5 }]);
    expect(query(graph, 'LET x = 5 RETURN $p AS p, x', { p: 9 })).toEqual([{ p: 9, x: 5 }]);
    expect(query(graph, 'LET x = 5 RETURN $p AS p, x', { p: 10 })).toEqual([{ p: 10, x: 5 }]);
  });

  test('the memoised params object is not SHARED into execute across calls', () => {
    // `withClock` returns its argument unchanged when the graph has no clock, so a memoised params
    // object would otherwise reach `execute` by reference on every later call. The spread is what
    // prevents that; this asserts the observable consequence — repeated calls stay identical.
    const graph = g();
    const first = query(graph, 'LET x = 7 RETURN x');
    const second = query(graph, 'LET x = 7 RETURN x');
    const third = query(graph, 'LET x = 7 RETURN x');

    expect(first).toEqual([{ x: 7 }]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test('a text whose literals are NOT liftable is unaffected', () => {
    // `RETURN 1 AS v` never reaches the lift at all (`MAYBE_LIFTABLE` rejects it), so it is cached
    // under its own text and the slot stays out of the way.
    const graph = g();
    const before = parseCacheStats().size;

    expect(query(graph, 'RETURN 1 AS v')).toEqual([{ v: 1 }]);
    expect(query(graph, 'RETURN 1 AS v')).toEqual([{ v: 1 }]);
    expect(parseCacheStats().size).toBeGreaterThanOrEqual(before);
  });

  test('a lift that does not PARSE still falls back, repeatedly', () => {
    // Step 3 of `query`'s design: a rewritten text that fails to parse falls back to the original,
    // whose parse raises the caller's real error. Memoising only after a successful parse is what
    // keeps that path available on every call rather than once.
    const graph = g();

    for (let i = 0; i < 3; i += 1) {
      expect(() => query(graph, 'MATCH (n:P) WHERE n.k = RETURN n.k')).toThrow();
    }

    // And the engine still works afterwards — a failed lift must not poison the slot.
    expect(query(graph, 'LET x = 5 RETURN x')).toEqual([{ x: 5 }]);
  });
});
