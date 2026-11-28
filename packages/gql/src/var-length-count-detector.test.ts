import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2465: `detectVarLengthCount`, from item 2460's coverage map — named in no test despite
 * eighteen `CLOSED.md` entries about the closed forms behind it.
 *
 * It is the richest detector taken so far: a six-guard admission chain, and it is the ONLY one
 * whose return type is `Row[] | undefined` rather than `Row[]`, because "a depth-4 trail's endpoint
 * label may be VACUOUS, which only the graph can say, so this rung is admitted at compile time and
 * declines at RUN time" (item 1399). So there are three outcomes to distinguish, not two:
 * `null` (never admitted), `undefined` from the returned function (admitted, then declined), and
 * rows.
 *
 * WHY UNIT TESTS. A route choice is answer-equivalent — the general matcher returns the same rows
 * more slowly — so a mutant in any guard below is invisible to every differential, fuzz and
 * conformance suite (`perf-gate-needs-its-own-test`). The widening direction is worse than slow
 * here: these counts are CLOSED FORMS, and the source says the depth ceiling exists because "at two
 * hops there is exactly one way to reuse an edge and the closed form subtracts it, while at three
 * there are several interacting ways and no single term". A relaxed bound meeting arithmetic that
 * was not relaxed with it is the mistake items 692 and 699 both made one depth down.
 *
 * Every admission is paired with the ROWS it produces, compared against the engine's own answer for
 * the same text (`gate-returning-a-value`). And every DECLINE names the guard it reaches, because a
 * decline is only evidence that SOME guard fired — item 2464 shipped four surviving mutants by
 * assuming otherwise.
 */

/** A 5-vertex chain a->b->c->d->e, every vertex labelled P. */
const build = (): Graph => {
  const g = new Graph();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const v: Record<string, ReturnType<Graph['addVertex']>> = {};

  for (const id of ids) {
    v[id] = g.addVertex({ id, labels: ['P'], properties: { k: 1 } });
  }

  for (let j = 0; j < ids.length - 1; j += 1) {
    g.addEdge({ id: `e${j}`, from: v[ids[j]], to: v[ids[j + 1]], labels: ['E'], properties: {} });
  }

  return g;
};

const g = build();

type Linear = Parameters<typeof compileLinear>[0];

const routes = (text: string) => {
  const parsed = parse(text) as { parts?: readonly unknown[] };

  return compileLinear((parsed.parts === undefined ? parsed : parsed.parts[0]) as Linear);
};

describe('detectVarLengthCount — admissions, with the rows they produce', () => {
  it('serves a bounded forward quantifier and counts every path length in range', () => {
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    // A 5-chain has 4 paths of length 1 and 3 of length 2.
    expect(compiled.varLengthCount).not.toBeNull();
    expect(compiled.varLengthCount?.(g, {})).toStrictEqual([{ c: 7 }]);
    expect(query(g, text, {})).toStrictEqual([{ c: 7 }]);
  });

  it('serves depth 3 and depth 4, where the counts are 4+3+2 and 4+3+2+1', () => {
    for (const [text, c] of [
      ['MATCH (a:P)-[:E]->{1,3}(x:P) RETURN count(*) AS c', 9],
      ['MATCH (a:P)-[:E]->{1,4}(x:P) RETURN count(*) AS c', 10],
    ] as const) {
      const compiled = routes(text);

      expect(compiled.varLengthCount).not.toBeNull();
      expect(compiled.varLengthCount?.(g, {})).toStrictEqual([{ c }]);
      expect(query(g, text, {})).toStrictEqual([{ c }]);
    }
  });

  it('serves ACYCLIC, which the source states is EXEMPT from the depth ceiling', () => {
    const text = 'MATCH ACYCLIC (a:P)-[:E]->{1,3}(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).not.toBeNull();
    expect(compiled.varLengthCount?.(g, {})).toStrictEqual([{ c: 9 }]);
    expect(query(g, text, {})).toStrictEqual([{ c: 9 }]);
  });

  it('serves an INWARD quantifier — mirrorAdmissible accepts it at a bounded max', () => {
    // On a chain the inward count equals the forward one, so this pins the MIRROR arm specifically
    // rather than a direction-agnostic answer.
    const text = 'MATCH (a:P)<-[:E]-{1,2}(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).not.toBeNull();
    expect(compiled.varLengthCount?.(g, {})).toStrictEqual([{ c: 7 }]);
    expect(query(g, text, {})).toStrictEqual([{ c: 7 }]);
  });
});

describe('detectVarLengthCount — declines, each naming the guard it reaches', () => {
  /*
   * THE THREE FIXTURES BELOW came from mutants that SURVIVED the first cut, and each was found by
   * applying the mutant and looking for a shape whose admission FLIPS — not by guessing. That is
   * item 2464's lesson applied: a decline only proves that SOME guard fired.
   */
  it('DECLINES a third clause, reaching the `clauses.length !== 2` guard', () => {
    // Post-pass `[match, for, return]`. Relaxing the guard to `< 2` makes this THROW rather than
    // decline, because the destructure then reads a `for` where a `return` is expected.
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P) FOR y IN [1] RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.clauses.map((c) => c.kind)).toStrictEqual(['match', 'for', 'return']);
    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 7 }]);
  });

  it("DECLINES a WRITE tail, reaching the `ret?.kind !== 'return'` guard", () => {
    // Post-pass `[match, set]`: two clauses, so the length guard passes and the kind check is what
    // refuses it. Dropping that check makes this throw.
    const compiled = routes('MATCH (a:P)-[:E]->{1,2}(x:P) SET x.k = 2');

    expect(compiled.clauses.map((c) => c.kind)).toStrictEqual(['match', 'set']);
    expect(compiled.varLengthCount).toBeNull();
  });

  it('DECLINES an INWARD quantifier whose max is below 2 — a DELIBERATE narrowing', () => {
    /*
     * `mirrorAdmissible` is `!inward || (max !== null && max >= 2)`, so an inward `{0,1}` is
     * refused while the inward `{1,2}` above is served.
     *
     * THIS PINS A POLICY, NOT A CORRECTNESS BARRIER, and the distinction is measured: with the
     * guard dropped, this shape is admitted and computes 9 — the SAME answer the general path
     * gives. The refusal exists to keep "a shallow or unbounded mirror on the route it has always
     * taken, rather than letting a relaxed bound meet arithmetic that was not relaxed with it —
     * the mistake items 692 and 699 both made one depth down". So the value of this assertion is
     * that a future widening has to be deliberate: it fails loudly rather than drifting.
     */
    const text = 'MATCH (a:P)<-[:E]-{0,1}(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 9 }]);
  });

  it('DECLINES an UNBOUNDED max, which mirrorAdmissible refuses', () => {
    // `*` also admits the zero-length path, so the general answer is larger than any bounded one:
    // 5 self-paths plus the 10 of length 1-4.
    const text = 'MATCH (a:P)-[:E]->*(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 15 }]);
  });

  it('DECLINES an OPTIONAL match, reaching the `m.optional` guard', () => {
    const text = 'OPTIONAL MATCH (a:P)-[:E]->{1,2}(x:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 7 }]);
  });

  it('DECLINES two patterns, reaching the `m.patterns.length !== 1` guard', () => {
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P), (y:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    // The cross product: 7 var-length paths x 5 vertices.
    expect(query(g, text, {})).toStrictEqual([{ c: 35 }]);
  });

  it('DECLINES an ORDER BY, which the projection guard refuses alongside the count column', () => {
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P) RETURN count(*) AS c ORDER BY c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 7 }]);
  });

  it('DECLINES a projection that is not count(*), reaching countStarColumn', () => {
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P) RETURN x.k AS k';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toHaveLength(7);
  });

  it('DECLINES a second segment, reaching degreeCountShape', () => {
    // The quantified segment is servable on its own; the extra hop is what disqualifies it, so this
    // isolates the SHAPE guard from the quantifier guards above.
    const text = 'MATCH (a:P)-[:E]->{1,2}(x:P)-[:E]->(z:P) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.varLengthCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 5 }]);
  });
});
