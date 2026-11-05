/**
 * MINIMIZING the cross-engine divergence item 1542's fuzz hunt caught.
 *
 * Reproduce the original with `FUZZ_SEED=2949348313 bun test src/differential-fuzz.test.ts` — it
 * replays DETERMINISTICALLY, which is what distinguishes it from the known rare-seed residual that
 * replays clean:
 *
 * ```text
 *   MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE
 *     (([1e400, local_time('08:30:00')]['a'] <= n.s) AND ((n.s || 0.0) IS NOT NULL)))
 *   RETURN t.n AS x, n.n AS y ORDER BY x, y
 *
 *   ts:     ok  [{"x":3,"y":null}, … 6 rows, every y null]
 *   native: err E_INVALID_VALUE
 * ```
 *
 * This file strips the query down a piece at a time to find which ingredient is load-bearing. It is
 * a DIAGNOSTIC, not a claim about which engine is right — it prints what both do and asserts only
 * that the comparison ran, so it can sit in the suite without encoding a verdict.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/**
 * Two `:T` vertices with an `s` property and one `:E` edge.
 *
 * ⚠️ JOINED INTO TEXT. `graphFromNdjson` and `tsDeserialize` both take the NDJSON text, which is
 * why the fuzzer hands the same value to both; passing an array reaches bun:ffi as a non-pointer
 * and the error ("cannot convert argument to 'ptr'") does not say that is why.
 */
const NDJSON = [
  '{"type":"node","id":"1","labels":["T"],"properties":{"n":3,"s":"a"}}',
  '{"type":"node","id":"2","labels":["T"],"properties":{"n":7,"s":"z"}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{"w":2}}',
].join('\n');

const CASES: Record<string, string> = {
  original:
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (([1e400, local_time('08:30:00')]['a'] <= n.s) AND ((n.s || 0.0) IS NOT NULL))) RETURN t.n AS x, n.n AS y ORDER BY x, y",
  'no-second-conjunct':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ([1e400, local_time('08:30:00')]['a'] <= n.s)) RETURN t.n AS x ORDER BY x",
  'plain-list-le':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ([1, 2]['a'] <= n.s)) RETURN t.n AS x ORDER BY x",
  'plain-list-eq':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ([1, 2]['a'] = n.s)) RETURN t.n AS x ORDER BY x",
  'index-is-null':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ([1, 2]['a'] IS NULL)) RETURN t.n AS x ORDER BY x",
  // Not behind an OPTIONAL MATCH: does the fault surface for BOTH engines here?
  'plain-where': "MATCH (t:T) WHERE ([1, 2]['a'] = t.s) RETURN t.n AS x ORDER BY x",
  // The expression with no pattern at all — the baseline for "what does each engine think
  // `list['a']` even is". Both say null, so the index is a RED HERRING.
  'bare-return': "RETURN [1, 2]['a'] AS x",

  // ⚠️ THE ACTUAL INGREDIENT, which the native error named: `|| requires all operands to …`.
  // `n.s || 0.0` concatenates a string with a NUMBER. Native raises E_INVALID_VALUE; TS does not —
  // and the reduction above shows every case WITHOUT this conjunct agreeing.
  'concat-alone': "RETURN ('a' || 0.0) AS x",
  // So the question is why TS never evaluates it in the original: `AND` with an UNKNOWN (null)
  // left operand. Item 258/259 settled that AND short-circuits on FALSE in both engines, in
  // written order. UNKNOWN is the case those items did not cover.
  'and-unknown-then-fault': "RETURN ((null <= 'z') AND (('a' || 0.0) IS NOT NULL)) AS x",
  'and-false-then-fault': "RETURN ((1 = 2) AND (('a' || 0.0) IS NOT NULL)) AS x",
  'and-true-then-fault': "RETURN ((1 = 1) AND (('a' || 0.0) IS NOT NULL)) AS x",
  // And the reverse order, to separate "short-circuit" from "evaluates right first".
  'fault-then-unknown': "RETURN ((('a' || 0.0) IS NOT NULL) AND (null <= 'z')) AS x",

  // ⚠️ EVERY SCALAR `AND` CASE ABOVE AGREES, so the AND semantics are NOT the divergence. What is
  // left is the CONTEXT: a faulting expression over the pattern variable's property, inside an
  // inline WHERE, inside an OPTIONAL MATCH. These three separate those factors.
  'optional-inline-fault':
    'MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ((n.s || 0.0) IS NOT NULL)) RETURN t.n AS x, n.n AS y ORDER BY x, y',
  'required-inline-fault':
    'MATCH (t:T) MATCH (t)-[:E]->(n WHERE ((n.s || 0.0) IS NOT NULL)) RETURN t.n AS x, n.n AS y ORDER BY x, y',
  'optional-clause-fault':
    'MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n) WHERE ((n.s || 0.0) IS NOT NULL) RETURN t.n AS x, n.n AS y ORDER BY x, y',

  // ⚠️ IS IT THE LIFT? The hypothesis (item 1543): the FIRST conjunct is lifted into `cmpProps`
  // and evaluated before `pred.where`, and an UNKNOWN lifted comparison returns `false` early — so
  // the faulting residual never runs. These separate the factors.
  //
  // The exotic literals should be irrelevant if that is the mechanism.
  'plain-pair-inline':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (([1, 2]['a'] <= n.s) AND ((n.s || 0.0) IS NOT NULL))) RETURN t.n AS x, n.n AS y ORDER BY x, y",
  // Order swapped: the FAULT first. If the lift is the mechanism, this raises in both.
  'swapped-fault-first':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE (((n.s || 0.0) IS NOT NULL) AND ([1, 2]['a'] <= n.s))) RETURN t.n AS x, n.n AS y ORDER BY x, y",
  // A first conjunct that is UNKNOWN but compares two NON-element expressions, so there is no
  // element property to lift against.
  'unliftable-unknown-first':
    "MATCH (t:T) OPTIONAL MATCH (t)-[:E]->(n WHERE ((null <= 'z') AND ((n.s || 0.0) IS NOT NULL))) RETURN t.n AS x, n.n AS y ORDER BY x, y",
  // And the same chain in a REQUIRED match, to show the OPTIONAL is not the factor.
  'required-pair-inline':
    "MATCH (t:T) MATCH (t)-[:E]->(n WHERE (([1, 2]['a'] <= n.s) AND ((n.s || 0.0) IS NOT NULL))) RETURN t.n AS x, n.n AS y ORDER BY x, y",
};

/**
 * The shapes that currently diverge, so the assertion below guards the REST.
 *
 * ⚠️ THE FAMILY IS WIDER THAN THE ORIGINAL AND NARROWER THAN "AND WITH UNKNOWN" (item 1543). Each
 * member pairs a conjunct comparing an ELEMENT PROPERTY (liftable into `cmpProps`) with a faulting
 * conjunct. `unliftable-unknown-first` uses `null <= 'z'` instead — nothing to lift — and both
 * engines AGREE, which is what points at the lift rather than at `AND`.
 *
 * And `swapped-fault-first` is why "written order" is NOT the explanation: the faulting conjunct is
 * written FIRST and TS still does not raise, because the lifted conjunct is hoisted ahead of the
 * residual `where` regardless of where it appeared.
 */
const KNOWN_DIVERGENT = new Set([
  'original',
  'plain-pair-inline',
  'swapped-fault-first',
  'required-pair-inline',
]);

const suite = nativeReady ? describe : describe.skip;

suite('item 1542 — the AND-with-UNKNOWN divergence inside a pattern predicate', () => {
  /**
   * ⚠️ WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT.
   *
   * Every reduction EXCEPT `original` must agree across the engines — that is the real invariant,
   * and it is a genuine regression guard: a new divergence appearing in any of these shapes fails
   * here with the shape named.
   *
   * `original` is the live bug and is only PRINTED. It is deliberately NOT added to
   * `divergence-registry.ts`: registering it would stop the differential fuzzer flagging it, which
   * is the opposite of what a real wrong answer needs. The fuzzer SHOULD keep failing on this
   * roughly 1 run in 8 until it is fixed.
   */
  test('every reduction agrees except the known-bad original', () => {
    const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
    const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());
    const run = (f: () => unknown): string => {
      try {
        return `ok ${JSON.stringify(f())}`;
      } catch (e) {
        return `err ${String(e).slice(0, 70)}`;
      }
    };
    const disagreeing: string[] = [];

    for (const [name, text] of Object.entries(CASES)) {
      const ts = run(() => tsQuery(tsGraph, text));
      const nat = run(() => nativeGraph.query(text));
      const agree = ts.startsWith('err') === nat.startsWith('err');

      if (KNOWN_DIVERGENT.has(name)) {
        console.log(`\n${name} (known-divergent, printed not asserted)`);
        console.log(`  ts:     ${ts.slice(0, 150)}`);
        console.log(`  native: ${nat.slice(0, 150)}`);
        continue;
      }

      if (!agree) {
        disagreeing.push(`${name}\n  ts:     ${ts.slice(0, 150)}\n  native: ${nat.slice(0, 150)}`);
      }
    }

    expect(disagreeing.join('\n')).toBe('');
  });

  /**
   * THE RULE, stated as a test so the characterization cannot rot.
   *
   * In a SCALAR context both engines evaluate the right operand of an `AND` whose left operand is
   * UNKNOWN, and both raise. Inside a PATTERN's inline `WHERE` they differ — which is why item
   * 258/259's settled finding ("AND short-circuits on FALSE in both engines, in written order") did
   * not cover this: it is UNKNOWN, not FALSE, and it is a pattern predicate, not a value position.
   */
  test('the scalar AND cases agree — the divergence is the PATTERN context, not AND itself', () => {
    const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
    const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

    for (const name of ['and-unknown-then-fault', 'and-false-then-fault', 'and-true-then-fault']) {
      const text = CASES[name];
      let tsErr = false;
      let natErr = false;

      try {
        tsQuery(tsGraph, text);
      } catch {
        tsErr = true;
      }

      try {
        nativeGraph.query(text);
      } catch {
        natErr = true;
      }

      expect(`${name}:${tsErr}`).toBe(`${name}:${natErr}`);
    }
  });
});
