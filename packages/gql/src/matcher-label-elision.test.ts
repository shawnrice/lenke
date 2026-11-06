import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { compileLinear } from './executor.ts';
import type { CPath } from './executor.ts';
import { effectiveLabels } from './executor/matching.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * The GENERIC MATCHER elides a label carried by EVERY vertex (item 1623) — **1.17x** on a
 * three-segment row projection, which is the full **1.19x** the ablation priced as the ceiling.
 *
 * `evalLabelExpr` 7.8% + `get labels` 3.6% = 11.4% of that shape's profile. Item 1599 refuted both
 * levers that make the TEST cheaper (a compiled closure measured FLAT, bucket identity measured
 * SLOWER than the getter); this removes the test where the label cannot reject anything, which is
 * the mechanism items 1551/1552/1609 built and measured at 5.58x on the seeded count.
 *
 * ⚠️ A WRONG ELISION IS A WRONG ANSWER, not a slow one — a selective label dropped means rows that
 * should have been filtered. So this file is about the REFUSALS as much as the win:
 *
 *   - a SELECTIVE label must not be elided;
 *   - the per-node array is indexed by DEPTH and index 0 is the pattern's START, so a segment at
 *     `index` reads `index + 1` — an off-by-one applies the wrong node's label;
 *   - `:%` (the wildcard) is NOT vacuous, which `vacuousLabel`'s own note records as measured: on a
 *     graph with one labelled and one unlabelled vertex, `MATCH (a)` answers 2 and `MATCH (a:%)` 1;
 *   - and the compiled plan is reused across EXECUTIONS AND GRAPHS, where vacuity is a property of
 *     the GRAPH — so the elision must never be written back onto the node.
 */
const build = (spec: readonly (readonly [string, readonly string[]])[]): Graph => {
  const g = new Graph();

  for (const [id, labels] of spec) {
    g.addVertex({ id, labels: [...labels], properties: { id } });
  }

  const ids = spec.map(([id]) => id);

  ids.forEach((from, i) => {
    const to = ids[(i + 1) % ids.length];

    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(from) as Vertex,
      to: g.getVertexById(to) as Vertex,
      labels: ['R'],
      properties: {},
    });
  });

  return g;
};

/** Every vertex `P`; `Q` on two of five. A ring of `R` edges, so every vertex has degree 1 each way. */
const g = build([
  ['a', ['P', 'Q']],
  ['b', ['P']],
  ['c', ['P', 'Q']],
  ['d', ['P']],
  ['e', ['P']],
]);

const ids = (src: string): string[] => (query(g, src) as { id: string }[]).map((r) => r.id).sort();

describe('the vacuous label is elided and the selective one is not', () => {
  test('a three-segment pattern whose labels are all vacuous', () => {
    // The ring is a>b>c>d>e>a, so three segments from each start: five paths, far ends d,e,a,b,c.
    expect(ids('MATCH (a:P)-[:R]->(b:P)-[:R]->(c:P)-[:R]->(x:P) RETURN x.id AS id')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    // Dropping every `:P` must answer the same, since `P` is on every vertex.
    expect(ids('MATCH (a)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  test('⚠️ a SELECTIVE label still filters, at EVERY position', () => {
    /**
     * ⚠️ DERIVED PROPERLY, after TWO of these four literals were wrong by eye — the nineteenth and
     * twentieth this session, and both from the same slip: I read the label position off the QUERY
     * text instead of walking the ring.
     *
     * The ring is a>b>c>d>e>a with `Q` on `a` and `c`. Index the starts 0..4 as (a,b,c,d,e); a
     * three-segment path from `i` visits i, i+1, i+2, i+3 (mod 5) and its far end is i+3:
     *
     * ```text
     *    i=0 (a) -> far d    i=1 (b) -> far e    i=2 (c) -> far a
     *    i=3 (d) -> far b    i=4 (e) -> far c
     * ```
     *
     * `:Q` at position p keeps the paths whose (i+p) mod 5 is 0 or 2:
     *
     * ```text
     *    p=0  i in {0,2}  -> far d, a   => [a, d]
     *    p=1  i in {4,1}  -> far c, e   => [c, e]
     *    p=2  i in {3,0}  -> far b, d   => [b, d]
     *    p=3  i in {2,4}  -> far a, c   => [a, c]
     * ```
     */
    expect(ids('MATCH (a:Q)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id')).toEqual(['a', 'd']);
    expect(ids('MATCH (a)-[:R]->(b:Q)-[:R]->(c)-[:R]->(x) RETURN x.id AS id')).toEqual(['c', 'e']);
    expect(ids('MATCH (a)-[:R]->(b)-[:R]->(c:Q)-[:R]->(x) RETURN x.id AS id')).toEqual(['b', 'd']);
    expect(ids('MATCH (a)-[:R]->(b)-[:R]->(c)-[:R]->(x:Q) RETURN x.id AS id')).toEqual(['a', 'c']);
  });

  test('⚠️ the per-node array is indexed by DEPTH — the off-by-one is observable', () => {
    /**
     * A selective label on exactly ONE position, with every other position unlabelled, so applying
     * the WRONG node's label gives a different answer for each. The four expectations above already
     * differ pairwise; this states the property they test.
     */
    const answers = [
      ids('MATCH (a:Q)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id').join(','),
      ids('MATCH (a)-[:R]->(b:Q)-[:R]->(c)-[:R]->(x) RETURN x.id AS id').join(','),
      ids('MATCH (a)-[:R]->(b)-[:R]->(c:Q)-[:R]->(x) RETURN x.id AS id').join(','),
      ids('MATCH (a)-[:R]->(b)-[:R]->(c)-[:R]->(x:Q) RETURN x.id AS id').join(','),
    ];

    /**
     * FOUR distinct answers, one per position — so EVERY off-by-one in the depth index is
     * observable, which is the strongest form this property takes. I predicted three on the wrong
     * belief that positions 0 and 2 coincide; they do not, and the derivation above says why.
     */
    expect(new Set(answers).size).toBe(4);
  });

  test('⚠️ `:%` is NOT vacuous, even though it reads as "any node"', () => {
    /**
     * `vacuousLabel`'s own note records this as measured rather than assumed: `:%` matches a node
     * that HAS a label, so on a graph with an unlabelled vertex it is selective. Eliding it would be
     * a wrong answer.
     */
    const mixed = build([
      ['x', ['P']],
      ['y', []],
    ]);

    expect(query(mixed, 'MATCH (a)-[:R]->(b) RETURN count(*) AS n')).toEqual([{ n: 2 }]);
    expect(query(mixed, 'MATCH (a:%)-[:R]->(b:%) RETURN count(*) AS n')).toEqual([{ n: 0 }]);
    expect(query(mixed, 'MATCH (a:%)-[:R]->(b) RETURN count(*) AS n')).toEqual([{ n: 1 }]);
  });

  test('COMPOUND vacuous spellings, which item 1549 found were being missed', () => {
    // `P|Q` is vacuous because `P` is; `P&P` because `P` is; `!Nope` because `Nope` is empty.
    for (const label of [':P|Q', ':Q|P', ':P&P', ':!Nope']) {
      expect(ids(`MATCH (a${label})-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id`)).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
      ]);
    }

    // And a compound that is NOT vacuous still filters: `Q&P` is `Q`, two of five.
    expect(ids('MATCH (a:Q&P)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id')).toEqual([
      'a',
      'd',
    ]);
  });

  test('⚠️ ONE COMPILED PLAN, TWO GRAPHS with different label distributions', () => {
    /**
     * THE REASON `matchNodeLabelled` TAKES A PARAMETER instead of writing the elided label back onto
     * the `CNode`. The compiled plan is reused across executions and across graphs, and vacuity is a
     * property of the GRAPH — so a plan that remembered the first graph's answer would give the
     * second one a wrong answer, and it would be a wrong answer that only appears on the second run.
     *
     * Here `Q` is VACUOUS in `allQ` and SELECTIVE in `g`. Running the same compiled plan against
     * both, in each order, must give each graph its own answer.
     */
    const allQ = build([
      ['a', ['P', 'Q']],
      ['b', ['P', 'Q']],
      ['c', ['P', 'Q']],
      ['d', ['P', 'Q']],
      ['e', ['P', 'Q']],
    ]);
    /**
     * ⚠️ VIA `query`, NOT `compile` — and that is the stronger test, not a convenience. The engine
     * keeps a PARSE+PLAN cache (items 228/229), so the same source string reuses the same compiled
     * plan across calls; running it against two graphs through `query` therefore exercises exactly
     * the reuse this is about, on the path a caller actually takes. (`compile` also wants a narrowed
     * `Query` where `parseQuery` returns a `Statement`, so the direct form needs a cast for nothing.)
     */
    const src = 'MATCH (a:Q)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id';
    const run = (graph: Graph): string[] =>
      (query(graph, src) as { id: string }[]).map((r) => r.id).sort();

    // Selective first, then vacuous — and then the reverse order on fresh reads of the same plan.
    expect(run(g)).toEqual(['a', 'd']);
    expect(run(allQ)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(run(g)).toEqual(['a', 'd']);
    expect(run(allQ)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('⚠️ the RESOLUTION itself, because an un-applied elision is answer-equivalent', () => {
    /**
     * Six of thirteen mutants in item 1623's pass survived, and every one was a variant of "the
     * elision does not happen" — which is the OLD behaviour and therefore answer-equivalent. That is
     * `perf-gate-needs-its-own-test`'s situation exactly, and its remedy applies here because
     * `effectiveLabels` IS a pure function: asserting its output directly kills the three mutants
     * that are about the resolution, and leaves only the ones about whether the caller consults it.
     *
     * Index 0 is the pattern's START, then one per segment.
     */
    const labelsOf = (src: string, graph: Graph): (string | undefined)[] => {
      const [part] = (parse(src) as never as { parts: readonly never[] }).parts;
      const cl = compileLinear(part) as unknown as { clauses: readonly { patterns?: unknown[] }[] };
      const [{ patterns }] = cl.clauses;
      const [pattern] = patterns as CPath[];

      return effectiveLabels(graph, pattern).map((l) =>
        l === undefined ? undefined : ((l as { name?: string }).name ?? l.kind),
      );
    };

    // `P` is vacuous at every position; `Q` is not.
    expect(labelsOf('MATCH (a:P)-[:R]->(b:P)-[:R]->(c:P) RETURN 1 AS n', g)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(labelsOf('MATCH (a:Q)-[:R]->(b:P)-[:R]->(c:Q) RETURN 1 AS n', g)).toEqual([
      'Q',
      undefined,
      'Q',
    ]);
    // An ABSENT label stays absent, and the array is still one per node.
    expect(labelsOf('MATCH (a)-[:R]->(b:Q)-[:R]->(c) RETURN 1 AS n', g)).toEqual([
      undefined,
      'Q',
      undefined,
    ]);
    // ⚠️ AND IT IS PER GRAPH: the same pattern over a graph where `Q` is universal elides it.
    const allQ = build([
      ['a', ['P', 'Q']],
      ['b', ['P', 'Q']],
      ['c', ['P', 'Q']],
    ]);

    expect(labelsOf('MATCH (a:Q)-[:R]->(b:P)-[:R]->(c:Q) RETURN 1 AS n', allQ)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('a label NOTHING carries still answers empty', () => {
    expect(ids('MATCH (a:Nope)-[:R]->(b)-[:R]->(c)-[:R]->(x) RETURN x.id AS id')).toEqual([]);
  });
});
