/**
 * `detectChainProjection` (item 1814) — a chain of three or more segments returning rows.
 *
 * ⚠️ THE ORACLE IS THE ENGINE'S OWN GENERAL MATCHER, reached by RESPELLING the same query with an
 * unused relationship VARIABLE. `hopOf` refuses `rel.variable !== undefined`, so
 * `-[r:R]->` declines the rung while meaning exactly what `-[:R]->` means when `r` is never read.
 * That gives a differential oracle inside one engine, which is what this family needs: the route is
 * ANSWER-EQUIVALENT, so a test that only checks the rung's rows against hand-written expectations
 * passes just as well when the rung never fires (`routes-fired.test.ts`'s own point, and item
 * 1713's mistake).
 *
 * Rows are compared as a MULTISET. Order is unspecified without an `ORDER BY` (item 198,
 * `order-is-unspecified`) and the rung emits start-driven depth-first; asserting a sequence here
 * would pin a free choice and fail the moment either path changed its walk order.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { farEndOnly } from './executor/chain-projection.ts';
import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/** The rungs a query takes, as `routes-fired.test.ts` reads them. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

const takesRung = (src: string): boolean => routes(src).includes('chainProjection');

/**
 * A chain graph with branching, so the row MULTIPLICITY is not 1 and a walk that loses a copy is
 * visible. Deliberately NOT the functional `(a*k+b) % N` shape CLAUDE.md warns about (items
 * 1516/1518): every fanout here is written out, so the distinct-endpoint count is obvious by
 * reading.
 */
const branching = (): Graph => {
  const g = new Graph();
  const ids = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'c3', 'd1', 'd2', 'f1', 'f2'];

  for (const [i, id] of ids.entries()) {
    g.addVertex({ id, labels: ['L'], properties: { k: i, s: `s${i}` } });
  }

  const edge = (id: string, from: string, to: string): void => {
    g.addEdge({
      id,
      from: g.getVertexById(from) as Vertex,
      to: g.getVertexById(to) as Vertex,
      labels: ['R'],
      properties: {},
    });
  };

  // a1 -> b1 -> {c1, c2} -> d1 ; a2 -> b2 -> c3 -> {d1, d2} ; then one more level for the
  // four-segment case, which otherwise compares two EMPTY results and asserts nothing.
  //
  // ⚠️ EDGE IDS ARE `r*`, NOT `e*`, so no vertex id can ever collide with one. A vertex and an edge
  // sharing an id is out of contract and SILENTLY destroys the vertex's labels and properties (one
  // id-keyed map across two id spaces, item 1588 — WON'T FIX, document only), and it cost nine
  // tests in this session once already.
  edge('r1', 'a1', 'b1');
  edge('r2', 'a2', 'b2');
  edge('r3', 'b1', 'c1');
  edge('r4', 'b1', 'c2');
  edge('r5', 'b2', 'c3');
  edge('r6', 'c1', 'd1');
  edge('r7', 'c2', 'd1');
  edge('r8', 'c3', 'd1');
  edge('r9', 'c3', 'd2');
  edge('r10', 'd1', 'f1');
  edge('r11', 'd2', 'f2');

  return g;
};

const sorted = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

/** The rung's rows against the general matcher's, as multisets, on the same graph. */
const agrees = (g: Graph, rung: string, oracle: string): void => {
  expect(takesRung(rung)).toBe(true);
  expect(takesRung(oracle)).toBe(false);

  const a = query(g, rung) as Record<string, unknown>[];
  const b = query(g, oracle) as Record<string, unknown>[];

  expect(sorted(a)).toEqual(sorted(b));
  // A pair of EMPTY results agrees trivially and would pass every assertion above, so the shape
  // has to produce rows for the comparison to have asked anything (the probes' own non-empty
  // floor, one family along).
  expect(a.length).toBeGreaterThan(0);
};

describe('the rung fires for its own shape and not for its neighbours', () => {
  it('takes three segments and up', () => {
    expect(takesRung('MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(true);
    expect(takesRung('MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)-[:R]->(e) RETURN e.k AS k')).toBe(
      true,
    );
  });

  it('leaves ONE and TWO segments to their own rungs', () => {
    expect(routes('MATCH (a:L)-[:R]->(b) RETURN b.k AS k')).toEqual(['hopProjection']);
    expect(routes('MATCH (a:L)-[:R]->(b)-[:R]->(c) RETURN c.k AS k')).toEqual(['hop2Projection']);
  });

  it('declines an UNDIRECTED leg anywhere in the chain', () => {
    // The largest shape in the GQL probe is this one, and it stays on the general matcher. See the
    // module header: `both` visits a self-loop from both ends.
    expect(takesRung('MATCH (a:L)-[:R]-(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(false);
    expect(takesRung('MATCH (a:L)-[:R]->(b)-[:R]-(c)-[:R]->(d) RETURN d.k AS k')).toBe(false);
    expect(takesRung('MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]-(d) RETURN d.k AS k')).toBe(false);
  });

  it('declines paging, DISTINCT, ORDER BY and an aggregate', () => {
    const chain = 'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)';

    expect(takesRung(`${chain} RETURN d.k AS k LIMIT 2`)).toBe(false);
    expect(takesRung(`${chain} RETURN d.k AS k SKIP 1`)).toBe(false);
    expect(takesRung(`${chain} RETURN DISTINCT d.k AS k`)).toBe(false);
    expect(takesRung(`${chain} RETURN d.k AS k ORDER BY k`)).toBe(false);
    expect(takesRung(`${chain} RETURN count(*) AS c`)).toBe(false);
    expect(takesRung(`${chain} RETURN max(d.k) AS m`)).toBe(false);
  });

  it('declines a relationship variable and a quantifier', () => {
    expect(takesRung('MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(false);
    expect(takesRung('MATCH (a:L)-[:R]->{1,2}(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(false);
  });

  /**
   * ⚠️ AN UNREAD PATH VARIABLE IS ADMITTED, AND I ASSERTED THE OPPOSITE FIRST. `compileLinear`
   * rewrites the clauses before any detector runs, and one of those rewrites ELIDES a path variable
   * nothing reads — so by the time `detectChainProjection` sees the pattern there is no `pathVar`
   * left to refuse. That is not this rung's behaviour but the engine's, checked across the family:
   * the one-hop and two-hop rungs admit their own shape with an unread `p` identically.
   *
   * Which makes the module's `pathVar` guard defence in depth rather than the live refusal — the
   * same status `hop2-projection.ts` records for its copy ("mutually redundant with the
   * free-variable test"). What actually declines a path variable is READING it, and that is the
   * assertion worth having.
   */
  it('declines a path variable that is READ, and admits one that is elided', () => {
    const chain = 'MATCH p = (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)';

    expect(takesRung(`${chain} RETURN nodes(p) AS n`)).toBe(false);
    expect(takesRung(`${chain} RETURN size(edges(p)) AS n`)).toBe(false);
    expect(takesRung(`${chain} RETURN d.k AS k`)).toBe(true);
  });

  it('declines an inline constraint and an untyped leg', () => {
    expect(takesRung('MATCH (a:L {k: 1})-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(
      false,
    );
    expect(takesRung('MATCH (a:L)-[:R]->(b {k: 1})-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(
      false,
    );
    // `hopOf` requires a single `label` node on the rel, so a TYPE UNION declines — one edge type
    // per leg is what the adjacency bucket read assumes.
    expect(takesRung('MATCH (a:L)-[:R|S]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k')).toBe(false);
  });

  /**
   * ⚠️ A MEASURED REFUSAL, not a conservative one. The general matcher rejects a start BEFORE
   * expanding it; this walk would pay one test per ROW. Admitted at two hops it measured 3.7x
   * WORSE (see `hop2-projection.ts`), and the ratio of rows to start vertices only grows with
   * depth.
   */
  it('declines a clause WHERE that reads the START variable, and carries the others', () => {
    const chain = 'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)';

    expect(takesRung(`${chain} WHERE a.k = 0 RETURN d.k AS k`)).toBe(false);
    expect(takesRung(`${chain} WHERE a.k = 0 AND d.k = 7 RETURN d.k AS k`)).toBe(false);
    expect(takesRung(`${chain} WHERE b.k = 2 RETURN d.k AS k`)).toBe(true);
    expect(takesRung(`${chain} WHERE d.k = 7 RETURN d.k AS k`)).toBe(true);
  });
});

describe('the rung answers what the general matcher answers', () => {
  const g = branching();

  it('a far-end projection over three segments', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k',
    );
  });

  /**
   * ⚠️ THE MULTIPLICITY IS THE POINT OF THIS ONE. Two distinct paths reach `d1` through `b1`, and
   * `c3` reaches both `d1` and `d2` — so the correct answer REPEATS a value, and a walk that
   * deduped or lost a branch would still return plausible rows. Asserted against the fixture
   * directly as well as against the matcher, because both paths could in principle share a bug.
   */
  it('keeps the row MULTIPLICITY of a branching chain', () => {
    const rows = query(g, 'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k') as {
      k: number;
    }[];

    // EVERY vertex carries `:L`, so the start ranges over the b level too — which is why adding a
    // fourth level to the fixture changed this expectation, and why the hand-written list is worth
    // keeping next to the oracle comparison: it is the half that notices.
    //
    //   a1->b1->c1->d1 (7)   a1->b1->c2->d1 (7)   a2->b2->c3->d1 (7)   a2->b2->c3->d2 (8)
    //   b1->c1->d1->f1 (9)   b1->c2->d1->f1 (9)   b2->c3->d1->f1 (9)   b2->c3->d2->f2 (10)
    expect(rows.map((r) => r.k).sort((x, y) => x - y)).toEqual([7, 7, 7, 8, 9, 9, 9, 10]);
  });

  it('projects several columns and interior variables', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN a.k AS a, b.k AS b, c.k AS c, d.k AS d',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN a.k AS a, b.k AS b, c.k AS c, d.k AS d',
    );
  });

  it('projects the ELEMENT, not only a property', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d',
    );
  });

  it('applies a label at every position', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN d.k AS k',
    );
  });

  it('carries a clause WHERE over a middle and a far position', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) WHERE c.k = 4 RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) WHERE c.k = 4 RETURN d.k AS k',
    );
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) WHERE d.k = 7 RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) WHERE d.k = 7 RETURN d.k AS k',
    );
  });

  /**
   * ⚠️ UNKNOWN MUST DROP LIKE FALSE. A clause `WHERE` keeps only rows whose predicate is definitely
   * TRUE, so a comparison against an ABSENT property keeps nothing — which is why the gate tests
   * `asTruth(...) !== true` rather than falsiness.
   */
  it('drops UNKNOWN rows, not just FALSE ones', () => {
    const q = 'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) WHERE d.missing = 1 RETURN d.k AS k';

    expect(takesRung(q)).toBe(true);
    expect(query(g, q)).toEqual([]);
  });

  it('agrees over FOUR segments', () => {
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d)-[:R]->(e) RETURN e.k AS k',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d)-[:R]->(e) RETURN e.k AS k',
    );
  });

  it('agrees on an INWARD chain and a mixed one', () => {
    agrees(
      g,
      'MATCH (a:L)<-[:R]-(b)<-[:R]-(c)<-[:R]-(d) RETURN d.k AS k',
      'MATCH (a:L)<-[r:R]-(b)<-[:R]-(c)<-[:R]-(d) RETURN d.k AS k',
    );
    agrees(
      g,
      'MATCH (a:L)-[:R]->(b)<-[:R]-(c)-[:R]->(d) RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b)<-[:R]-(c)-[:R]->(d) RETURN d.k AS k',
    );
  });

  it('returns nothing when a leg type does not exist, rather than faulting', () => {
    const q = 'MATCH (a:L)-[:R]->(b)-[:NOPE]->(c)-[:R]->(d) RETURN d.k AS k';

    expect(takesRung(q)).toBe(true);
    expect(query(g, q)).toEqual([]);
  });
});

/**
 * ⚠️ THE SELF-LOOP QUESTION, ASKED AT DEPTH THREE RATHER THAN ASSUMED FROM DEPTH TWO.
 *
 * `hop2-projection.ts` measured that the path MODE is not load-bearing across two segments — the
 * default, `WALK`, `TRAIL` and `ACYCLIC` all returned the same rows including one that reuses a loop
 * edge, because the restrictors apply per REPETITION of a quantifier and a quantifier is declined.
 * The reasoning carries to any depth, but a chain of three can traverse one loop edge THREE times,
 * which two cannot — so it is checked here against the matcher instead of inherited.
 */
describe('a self-loop at depth three', () => {
  const looped = (): Graph => {
    const g = new Graph();

    for (const id of ['x', 'y']) {
      g.addVertex({ id, labels: ['L'], properties: { k: id === 'x' ? 1 : 2 } });
    }

    g.addEdge({
      id: 'loop',
      from: g.getVertexById('x') as Vertex,
      to: g.getVertexById('x') as Vertex,
      labels: ['R'],
      properties: {},
    });
    g.addEdge({
      id: 'out',
      from: g.getVertexById('x') as Vertex,
      to: g.getVertexById('y') as Vertex,
      labels: ['R'],
      properties: {},
    });

    return g;
  };

  it('agrees with the general matcher, reused edge and all', () => {
    agrees(
      looped(),
      'MATCH (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k',
      'MATCH (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k',
    );
  });

  it('agrees under every explicit path mode', () => {
    const g = looped();

    for (const mode of ['WALK', 'TRAIL', 'ACYCLIC']) {
      const rung = `MATCH ${mode} (a:L)-[:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k`;
      const oracle = `MATCH ${mode} (a:L)-[r:R]->(b)-[:R]->(c)-[:R]->(d) RETURN d.k AS k`;
      const a = query(g, rung) as Record<string, unknown>[];
      const b = query(g, oracle) as Record<string, unknown>[];

      expect(sorted(a)).toEqual(sorted(b));
    }
  });
});

/**
 * Item 1816 — the BLOCKED LEVEL-SYNCHRONOUS sweep and the gate that chooses it.
 *
 * ⚠️ TWO THINGS HERE ARE NOT COVERED BY THE SUITE ABOVE, AND BOTH WERE MEASURED TO BE UNCOVERED.
 *
 * The first is the BLOCK BOUNDARY. `SWEEP_BLOCK` is 4096 starts and every fixture in this file is
 * three orders of magnitude smaller, so the 33 pre-existing tests that a `throw` in `sweepBlock`
 * proved reach it all run a SINGLE block — the buffer swap, the reuse across blocks and the
 * `nxtLen === nxt.length` growth path are exercised by none of them. A fixture that crosses the
 * boundary is the only way to reach that code.
 *
 * The second is the GATE. Choosing between two answer-equivalent walks is invisible to a
 * differential test by construction — `perf-gate-needs-its-own-test`'s rule — so `farEndOnly` is
 * exported and tested as a pure function rather than inferred from timings.
 */
describe('item 1816 — the blocked sweep', () => {
  /** Crosses `SWEEP_BLOCK` (4096): 5,000 starts over four levels, so there are at least two blocks. */
  const wide = (): Graph => {
    const g = new Graph();
    const n = 5000;

    for (let i = 0; i < n; i += 1) {
      g.addVertex({ id: `w${i}`, labels: ['W'], properties: { k: i % 7 } });
    }

    // Two out-edges per vertex, so multiplicity is not 1 and a dropped copy is visible, and the
    // targets are NOT a single linear map (items 1516/1518: `(a*k+b) % N` collapses a fanout).
    for (let i = 0; i < n; i += 1) {
      g.addEdge({
        id: `we${i}a`,
        from: g.getVertexById(`w${i}`) as Vertex,
        to: g.getVertexById(`w${(i + 1) % n}`) as Vertex,
        labels: ['R'],
        properties: {},
      });
      g.addEdge({
        id: `we${i}b`,
        from: g.getVertexById(`w${i}`) as Vertex,
        to: g.getVertexById(`w${(i * 13 + 5) % n}`) as Vertex,
        labels: ['R'],
        properties: {},
      });
    }

    return g;
  };

  it('agrees with the general matcher across a block boundary', () => {
    agrees(
      wide(),
      'MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) RETURN d.k AS k',
      'MATCH (a:W)-[r1:R]->(b:W)-[r2:R]->(c:W)-[r3:R]->(d:W) RETURN d.k AS k',
    );
  });

  it('emits the full multiplicity across a block boundary', () => {
    // Out-degree 2 at every level over 5,000 starts and three hops: 5000 * 2^3 rows, and a walk
    // that lost a copy per block or reused a buffer wrongly would come up short rather than wrong.
    const rows = query(
      wide(),
      'MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) RETURN d.k AS k',
    ) as Record<string, unknown>[];

    expect(rows.length).toBe(5000 * 8);
  });

  it('agrees across a block boundary with a carried WHERE on the far end', () => {
    agrees(
      wide(),
      'MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) WHERE d.k = 3 RETURN d.k AS k',
      'MATCH (a:W)-[r1:R]->(b:W)-[r2:R]->(c:W)-[r3:R]->(d:W) WHERE d.k = 3 RETURN d.k AS k',
    );
  });

  /**
   * ⚠️ THE CASE THE SWEEP CANNOT ANSWER, which is why the gate exists. Batching a level discards the
   * path that reached it, so an INTERIOR read has to route to the depth-first descent. If the gate
   * ever admitted this, the rows would be wrong rather than slow.
   */
  it('agrees when an INTERIOR variable is read, which routes to the descent', () => {
    agrees(
      wide(),
      'MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) RETURN b.k AS bk, d.k AS k',
      'MATCH (a:W)-[r1:R]->(b:W)-[r2:R]->(c:W)-[r3:R]->(d:W) RETURN b.k AS bk, d.k AS k',
    );
  });

  it('agrees when a carried WHERE reads an interior variable', () => {
    agrees(
      wide(),
      'MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) WHERE c.k = 2 RETURN d.k AS k',
      'MATCH (a:W)-[r1:R]->(b:W)-[r2:R]->(c:W)-[r3:R]->(d:W) WHERE c.k = 2 RETURN d.k AS k',
    );
  });

  it('still takes the rung in both routes', () => {
    expect(takesRung('MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) RETURN d.k AS k')).toBe(true);
    expect(
      takesRung('MATCH (a:W)-[:R]->(b:W)-[:R]->(c:W)-[:R]->(d:W) RETURN b.k AS bk, d.k AS k'),
    ).toBe(true);
  });
});

/**
 * The gate as a PURE FUNCTION. A route choice is answer-equivalent, so a mutant that inverts it
 * survives every differential test in this file — `perf-gate-needs-its-own-test`'s rule, and the
 * reason `farEndOnly` is exported at all.
 */
describe('item 1816 — farEndOnly', () => {
  /**
   * ⚠️ EXPRESSIONS COME FROM THE PARSER, NOT FROM HAND. The first cut of this test built
   * `{kind: 'property', target: {kind: 'variable', …}}` by hand and every case threw:
   * `freePredicateVars` has an exhaustive `never` arm, the real node is `{kind: 'prop', variable,
   * key}`, and a hand-written AST is a guess about the grammar that drifts the moment the grammar
   * moves. Parsing a one-line query instead makes the fixture the grammar's own.
   */
  const partOf = (src: string) =>
    (parse(src) as never as { parts: readonly { clauses: readonly Record<string, never>[] }[] })
      .parts[0];

  const v = (name: string) => {
    const ret = partOf(`MATCH (${name}:W) RETURN ${name}.k AS k`).clauses.find(
      (c) => c.kind === ('return' as never),
    ) as never as { projection: { items: readonly { expr: unknown }[] } };

    return ret.projection.items[0];
  };

  const whereOn = (name: string) => {
    const m = partOf(`MATCH (${name}:W) WHERE ${name}.k = 3 RETURN ${name}.k AS k`).clauses.find(
      (c) => c.kind === ('match' as never),
    ) as never as { where: unknown };

    return m.where;
  };

  it('admits a projection reading only the far variable', () => {
    expect(farEndOnly([v('d')], undefined, 'd')).toBe(true);
  });

  it('refuses a projection reading an interior variable', () => {
    expect(farEndOnly([v('d'), v('b')], undefined, 'd')).toBe(false);
  });

  it('refuses a WHERE reading an interior variable even when the projection is clean', () => {
    expect(farEndOnly([v('d')], whereOn('c'), 'd')).toBe(false);
  });

  it('admits a WHERE reading only the far variable', () => {
    expect(farEndOnly([v('d')], whereOn('d'), 'd')).toBe(true);
  });

  /** An UNNAMED far node cannot be read, so nothing could project it — and the sweep needs the key. */
  it('refuses an unnamed far node', () => {
    expect(farEndOnly([v('d')], undefined, undefined)).toBe(false);
  });
});
