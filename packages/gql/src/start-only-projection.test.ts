/**
 * ITEM 1525 — the start-driven hop projection gets `farDrivenHopWalk`'s template-and-copy when the
 * projection reads ONLY the start: every row a start vertex produces is then identical, so the
 * bucket SIZE is the row count and one `projectRow` serves the whole group.
 * `MATCH (a:P)-[:E]->() RETURN a.k` went from **251 to 117 ns/row (2.15x)** at 1,000,000 edges.
 *
 * ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the 3,800 tests in this package cannot see it taken or
 * dropped — `perf-gate-needs-its-own-test`. What they also cannot see is the route taken WRONGLY,
 * and that is a wrong ANSWER rather than a slow one, because this route derives the row COUNT from
 * the bucket size instead of from the edges it walked. Three ways to get it wrong:
 *
 *  1. **Anything that can reject an edge** makes the bucket size the wrong count — a non-vacuous far
 *     label, a far predicate.
 *  2. **A projection reading the far end** must not be folded: `RETURN a.k, x.k` has a DIFFERENT
 *     far value per row, and copying one template would repeat the first across the group.
 *  3. **The copies must be distinct objects.** `rows.push(template)` followed by `{ ...template }`
 *     is deliberate — the template is the first row — but pushing the same object `n` times would
 *     alias every row in a group to one object.
 *
 * Each is a case below, and each has a mutant recorded in the item that fails it.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Mixed out-degrees and a far label that rejects SOME edges, which is what makes the count tests
 * discriminating: a uniform fixture cannot tell `bucket.size` from the number of surviving edges.
 *
 *   a (k=1) → q1, q2, p1     out-degree 3, two of them `Q`
 *   b (k=2) → q1             out-degree 1, one of them `Q`
 *   c (k=3) →                out-degree 0 — a start with an EMPTY bucket
 */
const graph = (): Graph => {
  const g = new Graph();

  for (const [id, k, labels] of [
    ['a', 1, ['P']],
    ['b', 2, ['P']],
    ['c', 3, ['P']],
    ['q1', 9, ['P', 'Q']],
    ['q2', 8, ['P', 'Q']],
    ['p1', 7, ['P']],
  ] as const) {
    g.addVertex({ id, labels: [...labels], properties: { k } });
  }

  let e = 0;

  for (const [f, t] of [
    ['a', 'q1'],
    ['a', 'q2'],
    ['a', 'p1'],
    ['b', 'q1'],
  ] as const) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(f)!,
      to: g.getVertexById(t)!,
      // ⚠️ A DISTINCT `w` PER EDGE, and it has to be a real PROPERTY. My first version asserted on
      // `r.id` and read four nulls — `id` is the edge's IDENTITY, not a property, so ISO property
      // access on an absent key gives NULL and the column was uniformly null whether or not the
      // fold had wrongly fired. The test could not have failed for the reason it was written for.
      properties: { w: e + 1 },
    });
    e += 1;
  }

  return g;
};

const col = (rows: readonly Record<string, unknown>[], name: string): unknown[] =>
  rows.map((r) => r[name]).sort((x, y) => Number(x) - Number(y));

describe('a start-only projection folds to one row per edge, with the right count', () => {
  it('emits out-degree rows per start vertex', () => {
    // a contributes 3 (k=1), b contributes 1 (k=2), c contributes none.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k'), 'k')).toEqual([1, 1, 1, 2]);
  });

  it('a start with an EMPTY bucket contributes nothing', () => {
    // `c` has no out-edges. A fold that emitted one row per start vertex regardless would add a 3.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k'), 'k')).not.toContain(3);
  });

  it('⚠️ a NON-VACUOUS far label changes the count, so the fold must not use the bucket size', () => {
    // a→q1, a→q2 survive (k=1 twice); a→p1 does not; b→q1 survives (k=2). THREE rows, not four.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(:Q) RETURN a.k AS k'), 'k')).toEqual([1, 1, 2]);
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x:Q) RETURN a.k AS k'), 'k')).toEqual([1, 1, 2]);
  });

  it('⚠️ a far PREDICATE changes the count too', () => {
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x) WHERE x.k > 8 RETURN a.k AS k'), 'k')).toEqual(
      [1, 2],
    );
  });

  it('a VACUOUS far label is the folded case and still answers', () => {
    // Every vertex carries `P`, so `(:P)` rejects nothing and the bucket size IS the count.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(:P) RETURN a.k AS k'), 'k')).toEqual([
      1, 1, 1, 2,
    ]);
  });
});

describe('⚠️ the fold must not apply when the projection reads the far end', () => {
  it('RETURN a.k, x.k keeps a DISTINCT far value per row', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->(x) RETURN a.k AS k, x.k AS j');
    const pairs = rows.map((r) => `${String(r.k)}/${String(r.j)}`).sort();

    // Folding would give 1/9, 1/9, 1/9, 2/9 — the first far value repeated across a's group.
    expect(pairs).toEqual(['1/7', '1/8', '1/9', '2/9']);
  });

  it('RETURN x.k alone is the far-driven case and is unaffected', () => {
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->(x) RETURN x.k AS j'), 'j')).toEqual([7, 8, 9, 9]);
  });

  it('a projected REL variable is not folded either', () => {
    const rows = query(graph(), 'MATCH (a:P)-[r:E]->() RETURN a.k AS k, r.w AS w');

    expect(rows).toHaveLength(4);
    // Four edges with distinct `w`, so four distinct values — a fold would repeat one per group.
    expect(new Set(rows.map((r) => r.w)).size).toBe(4);
    expect(col(rows, 'w')).toEqual([1, 2, 3, 4]);
  });
});

describe('⚠️ the copies are distinct objects', () => {
  it('rows in one group are not the same object', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k');
    const ones = rows.filter((r) => r.k === 1);

    expect(ones).toHaveLength(3);
    // `rows.push(template)` then `{ ...template }` — the template IS the first row, and the rest
    // are clones. Pushing the template `n` times would alias them, which a caller mutating one row
    // would see. Identity, not equality, is the assertion.
    expect(ones[0]).not.toBe(ones[1]);
    expect(ones[1]).not.toBe(ones[2]);
  });

  it('mutating one row does not touch its siblings', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k');
    const ones = rows.filter((r) => r.k === 1);

    (ones[0] as Record<string, unknown>).k = 99;
    expect(ones[1].k).toBe(1);
    expect(ones[2].k).toBe(1);
  });
});

describe('the neighbouring shapes still answer', () => {
  it('RETURN * is unaffected and names only the bound variables', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:E]->() RETURN *');

    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0])).toEqual(['a']);
  });

  it('a START predicate plus a start-only projection still answers', () => {
    // `gate` is defined, so this takes the start-only PREDICATE closure, not the fold.
    expect(col(query(graph(), 'MATCH (a:P)-[:E]->() WHERE a.k > 1 RETURN a.k AS k'), 'k')).toEqual([
      2,
    ]);
  });

  it('an aggregate over a start-only projection is unaffected', () => {
    expect(query(graph(), 'MATCH (a:P)-[:E]->() RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  it('ORDER BY over the folded shape is still ordered', () => {
    expect(query(graph(), 'MATCH (a:P)-[:E]->() RETURN a.k AS k ORDER BY k DESC')).toEqual([
      { k: 2 },
      { k: 1 },
      { k: 1 },
      { k: 1 },
    ]);
  });
});

/**
 * ⚠️ ITEM 1527 — the SAME fold under a start-only PREDICATE. The gate rejects the start VERTEX, so
 * every row a surviving vertex produces is still identical. `WHERE a.age > 5 RETURN a.age` went from
 * 250.7 to 113.6 ns/row (2.21x).
 *
 * The cases that matter here are the RAISE PARITY ones. That closure wraps its gate in a try/catch
 * (items 139, 142, 144, 145) because the general path evaluates a clause `WHERE` once per COMPLETE
 * match — so a start that yields no row must never have it evaluated. On a fault it decides whether
 * to rethrow by asking whether the general path would have reached the vertex at all. The fold sits
 * AFTER that block, and these two tests are what prove it did not disturb it.
 */
describe('⚠️ the fold under a start-only predicate', () => {
  const gated = (): Graph => {
    const g = graph();

    return g;
  };

  it('gates the start vertex and still emits out-degree rows for survivors', () => {
    // a (k=1) is rejected; b (k=2) keeps its single edge. c has no edges either way.
    expect(col(query(gated(), 'MATCH (a:P)-[:E]->() WHERE a.k > 1 RETURN a.k AS k'), 'k')).toEqual([
      2,
    ]);
  });

  it('a gate that keeps everything still gives every row', () => {
    expect(col(query(gated(), 'MATCH (a:P)-[:E]->() WHERE a.k > 0 RETURN a.k AS k'), 'k')).toEqual([
      1, 1, 1, 2,
    ]);
  });

  it('⚠️ a gate PLUS a non-vacuous far label still counts the surviving edges', () => {
    // a is kept (k=1 > 0) and has two `Q` edges; b is kept and has one. The fold must NOT fire.
    expect(
      col(query(gated(), 'MATCH (a:P)-[:E]->(:Q) WHERE a.k > 0 RETURN a.k AS k'), 'k'),
    ).toEqual([1, 1, 2]);
  });

  it('⚠️ a gate PLUS a far predicate still rejects per edge', () => {
    expect(
      col(query(gated(), 'MATCH (a:P)-[:E]->(x) WHERE a.k > 0 AND x.k > 8 RETURN a.k AS k'), 'k'),
    ).toEqual([1, 2]);
  });

  /** A graph where `bad`'s `s` cannot be cast, so the gate FAULTS on it. */
  const faulting = (withEdge: boolean): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'bad', labels: ['P'], properties: { s: 'nope', k: 1 } });
    g.addVertex({ id: 'ok', labels: ['P'], properties: { s: '7', k: 2 } });
    g.addVertex({ id: 't', labels: ['P'], properties: { s: '1', k: 3 } });
    g.addEdge({ id: 'e0', labels: ['E'], from: g.getVertexById('ok')!, to: g.getVertexById('t')! });

    if (withEdge) {
      g.addEdge({
        id: 'e1',
        labels: ['E'],
        from: g.getVertexById('bad')!,
        to: g.getVertexById('t')!,
      });
    }

    return g;
  };

  const FAULTY = 'MATCH (a:P)-[:E]->() WHERE CAST(a.s AS INTEGER) > 0 RETURN a.k AS k';

  it('⚠️ RAISE PARITY: a faulting gate on a start with NO edge is suppressed', () => {
    // The general path would never evaluate the predicate for `bad`, so neither may this one.
    expect(query(faulting(false), FAULTY)).toEqual([{ k: 2 }]);
  });

  it('⚠️ RAISE PARITY: a faulting gate on a start WITH an edge raises', () => {
    expect(() => query(faulting(true), FAULTY)).toThrow();
  });
});

/**
 * ⚠️ ITEM 1529 — `undirectedHopWalk` used to DECLINE any projection reading the start, which put
 * `MATCH (a:P)-[:E]-() RETURN a.age` on the general matcher at **741.3 ns/row against the same hop's
 * 197.7 with a far projection — 3.75x**. Admitting it is 3.06x.
 *
 * The route is answer-equivalent, so these are about the two ways admitting it can be WRONG, both of
 * which are wrong ANSWERS:
 *
 *  1. **The pairing.** An undirected hop yields a row from each end of an edge, so the start and the
 *     far must SWAP between the two rows. Binding one and not the other, or binding the same end
 *     twice, gives the right row count with wrong values.
 *  2. **The self-loop.** A loop yields exactly ONE row. The two-pass walk gets that from its in-pass
 *     skip; the edge-pass arm needs its own `from !== to` test, and that arm is the one a label-free
 *     query takes.
 *
 * Both arms are exercised: a label-free query takes the EDGE PASS (item 1431), a narrowing label
 * takes the TWO-PASS walk.
 */
describe('⚠️ the undirected hop may project the start (item 1529)', () => {
  /**
   * `a → b`, `b → q`, `a → a` (a SELF LOOP), `c → z` where `z` is not `P`.
   *
   * The self-loop and the non-`P` far end are what make the counts discriminating.
   */
  const undir = (): Graph => {
    const g = new Graph();

    for (const [id, k, labels] of [
      ['a', 1, ['P']],
      ['b', 2, ['P']],
      ['c', 3, ['P']],
      ['q', 9, ['P', 'Q']],
      ['z', 4, ['Z']],
    ] as const) {
      g.addVertex({ id, labels: [...labels], properties: { k } });
    }

    let e = 0;

    for (const [f, t] of [
      ['a', 'b'],
      ['b', 'q'],
      ['a', 'a'],
      ['c', 'z'],
    ] as const) {
      g.addEdge({ id: `u${e}`, labels: ['E'], from: g.getVertexById(f)!, to: g.getVertexById(t)! });
      e += 1;
    }

    return g;
  };

  it('⚠️ the EDGE-PASS arm (no labels): one row per end, and a self-loop gives ONE', () => {
    // 4 edges: a-b → 2 rows, b-q → 2, a-a → 1 (the loop), c-z → 2. Seven rows.
    expect(col(query(undir(), 'MATCH (a)-[:E]-() RETURN a.k AS k'), 'k')).toEqual([
      1, 1, 2, 2, 3, 4, 9,
    ]);
  });

  it('the TWO-PASS arm (a narrowing start label) agrees', () => {
    // `Z` is excluded as a START, so `z`'s row (k=4) goes and the other six stay.
    expect(col(query(undir(), 'MATCH (a:P)-[:E]-() RETURN a.k AS k'), 'k')).toEqual([
      1, 1, 2, 2, 3, 9,
    ]);
  });

  it('a narrowing FAR label still filters', () => {
    // Only `b-q` has a `Q` end, met from `b`. One row, k=2.
    expect(col(query(undir(), 'MATCH (a:P)-[:E]-(:Q) RETURN a.k AS k'), 'k')).toEqual([2]);
  });

  it('⚠️ THE PAIRING: both ends projected must SWAP between the two rows of an edge', () => {
    const rows = query(undir(), 'MATCH (a)-[:E]-(x) RETURN a.k AS k, x.k AS j');
    const pairs = rows.map((r) => `${String(r.k)}-${String(r.j)}`).sort();

    // Each edge appears from both ends with the roles swapped, and the loop appears once as 1-1.
    expect(pairs).toEqual(['1-1', '1-2', '2-1', '2-9', '3-4', '4-3', '9-2']);
  });

  it('the far projection is unchanged — it never needed the start', () => {
    expect(col(query(undir(), 'MATCH (a:P)-[:E]-(x) RETURN x.k AS j'), 'j')).toEqual([
      1, 1, 2, 2, 4, 9,
    ]);
  });

  it('a far predicate still declines the walk and still answers', () => {
    expect(col(query(undir(), 'MATCH (a:P)-[:E]-(x) WHERE x.k > 3 RETURN a.k AS k'), 'k')).toEqual([
      2, 3,
    ]);
  });
});

/**
 * ⚠️ ITEM 1531 — `undirectedHopWalk` now carries a START-ONLY gate, where it used to decline every
 * gate and send the query to the general matcher. `MATCH (a:P)-[:E]-(x) WHERE a.age > 5 RETURN
 * x.age` went **1083.4 → 391.2 ns/row (2.77x)**.
 *
 * ⚠️ THE RAISE PARITY SPANS BOTH DIRECTIONS HERE, and that is the one thing this route can get wrong
 * in a way no row assertion sees. The general path produces a row for a vertex if ANY incident edge —
 * out OR in — would have survived, so a fault must rethrow in both cases. Checking only `adjFrom`
 * would SWALLOW a fault that the general path raises, and the `IN-edge only` case below is the one
 * that catches it.
 */
describe('⚠️ a start-only gate on the undirected hop (item 1531)', () => {
  const gated = (): Graph => {
    const g = new Graph();

    for (const [id, k, labels] of [
      ['a', 1, ['P']],
      ['b', 7, ['P']],
      ['c', 3, ['P']],
      ['q', 9, ['P', 'Q']],
      ['z', 4, ['Z']],
    ] as const) {
      g.addVertex({ id, labels: [...labels], properties: { k } });
    }

    let e = 0;

    for (const [f, t] of [
      ['a', 'b'],
      ['b', 'q'],
      ['a', 'a'],
      ['c', 'z'],
    ] as const) {
      g.addEdge({ id: `w${e}`, labels: ['E'], from: g.getVertexById(f)!, to: g.getVertexById(t)! });
      e += 1;
    }

    return g;
  };

  it('gates the start vertex and answers over both directions', () => {
    // Starts with k > 2: b (7), c (3), q (9). b-a, b-q, q-b, c-z → [1,4,7,9].
    expect(col(query(gated(), 'MATCH (a:P)-[:E]-(x) WHERE a.k > 2 RETURN x.k AS j'), 'j')).toEqual([
      1, 4, 7, 9,
    ]);
  });

  it('a gate plus a narrowing far label', () => {
    expect(
      col(query(gated(), 'MATCH (a:P)-[:E]-(x:Q) WHERE a.k > 2 RETURN x.k AS j'), 'j'),
    ).toEqual([9]);
  });

  it('a FAR-reading predicate still declines the walk and still answers', () => {
    // `startOnly` is false, so the gate is refused and the general path takes it.
    //
    // ⚠️ [7, 7, 9] AND NOT [7, 9, 9], which is what I first wrote. `b`(7) is reached twice — once
    // as `a`'s far end and once as `q`'s — while `q`(9) is reached only from `b`. Checked against a
    // brute-force undirected walk rather than recounted by hand.
    expect(col(query(gated(), 'MATCH (a:P)-[:E]-(x) WHERE x.k > 6 RETURN x.k AS j'), 'j')).toEqual([
      7, 7, 9,
    ]);
  });

  /**
   * `bad`'s `s` cannot be cast, so the gate FAULTS on it. Whether that fault may surface depends on
   * whether the general path would have produced a row for `bad` — which for an undirected hop
   * means ANY incident edge, in either direction, surviving the far label.
   */
  const faulting = (opts: { edge: 'none' | 'in'; farQ: boolean; farLabel: boolean }): Graph => {
    const g = new Graph();

    g.addVertex({ id: 'bad', labels: ['P'], properties: { s: 'nope', k: 1 } });
    g.addVertex({ id: 'ok', labels: ['P'], properties: { s: '7', k: 2 } });
    g.addVertex({ id: 't', labels: ['P', 'Q'], properties: { s: '1', k: 3 } });
    g.addVertex({ id: 'n', labels: ['P'], properties: { s: '1', k: 4 } });
    g.addEdge({ id: 'f0', labels: ['E'], from: g.getVertexById('ok')!, to: g.getVertexById('t')! });

    if (opts.edge === 'in') {
      // An edge INTO `bad`, so it appears only in `adjTo`.
      g.addEdge({
        id: 'f1',
        labels: ['E'],
        from: g.getVertexById(opts.farQ ? 't' : 'n')!,
        to: g.getVertexById('bad')!,
      });
    }

    return g;
  };

  const q = (farLabel: boolean): string =>
    `MATCH (a:P)-[:E]-(x${farLabel ? ':Q' : ''}) WHERE CAST(a.s AS INTEGER) > 0 RETURN x.k AS j`;

  it('⚠️ PARITY: no incident edge at all — the fault is suppressed', () => {
    expect(
      col(query(faulting({ edge: 'none', farQ: false, farLabel: false }), q(false)), 'j'),
    ).toEqual([2, 3]);
  });

  it('⚠️ PARITY: an IN-edge only — the fault must RAISE (checking only adjFrom would swallow it)', () => {
    expect(() => query(faulting({ edge: 'in', farQ: false, farLabel: false }), q(false))).toThrow();
  });

  it('⚠️ PARITY: an IN-edge whose far end fails the label — suppressed', () => {
    expect(col(query(faulting({ edge: 'in', farQ: false, farLabel: true }), q(true)), 'j')).toEqual(
      [3],
    );
  });

  it('⚠️ PARITY: an IN-edge whose far end PASSES the label — raises', () => {
    expect(() => query(faulting({ edge: 'in', farQ: true, farLabel: true }), q(true))).toThrow();
  });
});
