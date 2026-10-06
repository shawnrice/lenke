import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// A START-ONLY clause `WHERE` on a one-hop projection. `carriedWhere` refused any clause `WHERE`
// that did not read the FAR variable, so this declined the fused walk entirely.
//
// That refusal was CORRECT while the walk did not seed: item 177 measured the walk at 3966us
// against the general path's 49.6 on an indexed graph, because the walk scanned a whole label
// while the general path went straight to the index. The walk seeds now — the same answer items
// 176 and 206 reached for the one- and two-hop counts — so the filter can be carried, and it is
// applied PER START VERTEX rather than per row (audit item 207):
//
//     before                       51.8ms unindexed / 0.6ms indexed
//     seeded, gate per row         31.5ms
//     seeded, gate per vertex      17.0ms / 0.6ms indexed
//
// The two things only a test can hold are RAISE PARITY — the general path evaluates a clause
// `WHERE` once per COMPLETE match, so a start yielding no row never has it evaluated at all — and
// the subquery decline, because item 175's seed gate orders cheap conjuncts first and a walk that
// evaluates the whole predicate at once loses that.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: [label], properties: props });

  const a1 = v('a1', 'A', { age: 50, name: 'x', v: 1 });
  const a2 = v('a2', 'A', { age: 20, name: 'y', v: 2 });
  const a3 = v('a3', 'A', { name: 'z', v: 3 }); // no `age` — three-valued
  // Same name, WRONG label: an index seek on `name` returns it and only the label re-check drops
  // it.
  const w1 = v('w1', 'W', { age: 50, name: 'x', v: 4 });
  // Passes the filter but has NO outgoing edge of the type at all.
  // Deliberately EDGELESS, so it is never wired up below — that is the point of it.
  v('a4', 'A', { age: 70, name: 'q', v: 'not-a-number' });
  // Passes the filter and has an edge, but its far end is the WRONG LABEL — so the general path
  // yields no row for it and never evaluates the predicate. The raise-parity case.
  const a5 = v('a5', 'A', { age: 80, name: 'r', v: 'not-a-number' });

  const f1 = v('f1', 'F', { k: 'f1' });
  const f2 = v('f2', 'F', { k: 'f2' });
  const bad = v('bad', 'BAD', { k: 'bad' });

  const e = (from: ReturnType<typeof v>, to: ReturnType<typeof v>, type = 'T') =>
    g.addEdge({ from, to, labels: [type], properties: {} });

  e(a1, f1);
  e(a1, f2);
  e(a2, f1);
  e(a3, f1);
  e(w1, f1);
  e(a5, bad); // a5's only edge goes to the wrong far label
  // a1 passes the filter and reaches BOTH a valid and an invalid far label over `T`. Without
  // this no start had that mix, so the emitting loop's far-label check was unobservable: a walk
  // that dropped it answered correctly on every case in the file.
  e(a1, bad);
  // An edge of another type out of a1, so the walk's type filter is observable.
  e(a1, bad, 'OTHER');

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the fused walk declines. */
const viaGeneral = (q: string, params?: Record<string, unknown>) =>
  query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '), params);

// Row order without an `ORDER BY` is UNSPECIFIED in this engine, as in SQL — settled in item
// 198 — and the two plans genuinely differ: the unfiltered hop takes the FAR-driven walk while
// the forced-general spelling is start-driven. So these compare as MULTISETS, and the ordered
// expectations below are written sorted. Pinning the order here would assert exactly the thing
// the engine declines to promise.
const bag = (rows: readonly Record<string, unknown>[]): string[] =>
  rows.map((r) => JSON.stringify(r)).sort();

const agree = (q: string, params?: Record<string, unknown>) => {
  const fast = query(g, q, params);

  expect(bag(fast)).toEqual(bag(viaGeneral(q, params)));

  return bag(fast);
};

describe('a start-only filter on a one-hop projection', () => {
  test('answers as the general path does', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN f.k AS k')).toEqual(
      bag([{ k: 'f1' }, { k: 'f2' }]),
    );
  });

  test('a param, which is what an index would seed from', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.name = $n RETURN f.k AS k', { n: 'x' })).toEqual(
      bag([{ k: 'f1' }, { k: 'f2' }]),
    );
  });

  test('the far end may be projected, the start, or both', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN a.name AS a, f.k AS k')).toEqual(
      bag([
        { a: 'x', k: 'f1' },
        { a: 'x', k: 'f2' },
      ]),
    );
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN a.name AS a')).toEqual(
      bag([{ a: 'x' }, { a: 'x' }]),
    );
  });

  test('an absent key does not pass — ISO three-valued', () => {
    // a3 has no `age`, so `a3.age > 40` is UNKNOWN and its edge to f1 must not appear.
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN f.k AS k')).toEqual(
      bag([{ k: 'f1' }, { k: 'f2' }]),
    );
  });

  test('the inverse filter, so the fixture distinguishes which starts passed', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age < 40 RETURN f.k AS k')).toEqual(
      bag([{ k: 'f1' }]),
    );
  });

  test('nothing passes', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 999 RETURN f.k AS k')).toEqual([]);
  });

  test('the first leg still respects its edge TYPE', () => {
    // a1 also has an OTHER edge to `bad`, so a walk ignoring the type would emit a SECOND `bad`.
    // One `bad` is expected: a5 (age 80) reaches it over a genuine `T` edge, and with no far
    // label that is a valid end — which is exactly why the duplicate is the signal here and the
    // presence of `bad` is not.
    expect(agree('MATCH (a:A)-[:T]->(x) WHERE a.age > 40 RETURN x.k AS k')).toEqual(
      bag([{ k: 'f1' }, { k: 'f2' }, { k: 'bad' }, { k: 'bad' }]),
    );
  });

  test('a REVERSED hop', () => {
    const q = 'MATCH (f:F)<-[:T]-(a:A) WHERE f.k = "f2" RETURN a.name AS n';

    expect(bag(query(g, q))).toEqual(bag(viaGeneral(q)));
  });
});

describe('the label is re-checked when the start is SEEDED', () => {
  const seeded = () => {
    const h = build();

    h.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

    return h;
  };

  test('a same-named WRONG-LABEL start is excluded', () => {
    const q = 'MATCH (a:A)-[:T]->(f:F) WHERE a.name = $n RETURN f.k AS k';

    // w1 is label W, name 'x', and points at f1. Leaking it would add a third row.
    expect(query(seeded(), q, { n: 'x' })).toEqual([{ k: 'f1' }, { k: 'f2' }]);
    expect(query(seeded(), q, { n: 'x' })).toEqual(query(build(), q, { n: 'x' }));
  });

  test('an UNLABELLED start over an index keeps the wrong-label vertex', () => {
    // The mirror: with no label to constrain it, w1 SHOULD appear. A re-check that rejected
    // everything would pass the test above and fail this one.
    const q = 'MATCH (a)-[:T]->(f:F) WHERE a.name = $n RETURN f.k AS k';
    const rows = query(seeded(), q, { n: 'x' });

    expect(rows).toEqual(query(build(), q, { n: 'x' }));
    expect(rows.length).toBe(3);
  });
});

describe('raise parity: the predicate is evaluated where the general path evaluates it', () => {
  // The fault is per-VERTEX, not per-query: `a.v / 1 > 0` is fine for a1/a2/a3 (numeric `v`) and
  // raises for a4 and a5, whose `v` is a string. An `AND` cannot express this — TS does not
  // short-circuit a data exception behind a false conjunct (`and-chain-seeding-divergence`), so
  // `name = 'q' AND <fault>` faults on EVERY vertex and both paths raise, which isolates nothing.
  // That is what the first version of these tests did.
  const FAULT = 'MATCH (a:A)-[:T]->(f:F) WHERE a.v / 1 > 0 RETURN f.k AS k';

  const raised = (q: string): boolean => {
    try {
      query(g, q);

      return false;
    } catch {
      return true;
    }
  };

  test('a4 has NO matching edge and a5 has no VALID far end, so neither is evaluated', () => {
    // The general path evaluates a clause `WHERE` once per COMPLETE match. a4 has no `T` edge at
    // all; a5 has one, to `bad`, which is not `:F`. Neither yields a row, so neither has the
    // predicate evaluated — and the walk must match that, which is why its fault path asks
    // "would any far end have produced a row?" rather than "does this vertex have edges?".
    expect(raised(FAULT.replace(' RETURN ', ' LET _z = 1 RETURN '))).toBe(false);
    expect(raised(FAULT)).toBe(false);
  });

  test('and the answer is the same on both paths', () => {
    expect(bag(query(g, FAULT))).toEqual(bag(viaGeneral(FAULT)));
    expect(bag(query(g, FAULT))).toEqual(bag([{ k: 'f1' }, { k: 'f2' }, { k: 'f1' }, { k: 'f1' }]));
  });

  test('a start that WOULD produce a row DOES raise, on both paths', () => {
    // Give a1 a faulting `v` instead, so the vertex that faults is one with two valid far ends.
    // A fault path that swallowed everything would pass the test above and fail this one.
    const h = new Graph();
    const x1 = h.addVertex({ id: 'x1', labels: ['A'], properties: { v: 'boom' } });
    const y1 = h.addVertex({ id: 'y1', labels: ['F'], properties: { k: 'y1' } });

    h.addEdge({ from: x1, to: y1, labels: ['T'], properties: {} });

    const q = 'MATCH (a:A)-[:T]->(f:F) WHERE a.v / 1 > 0 RETURN f.k AS k';
    const fast = (() => {
      try {
        query(h, q);

        return false;
      } catch {
        return true;
      }
    })();
    const general = (() => {
      try {
        query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

        return false;
      } catch {
        return true;
      }
    })();

    expect(fast).toBe(true);
    expect(general).toBe(true);
  });
});

describe('the shapes it must still decline', () => {
  test('a start-only predicate carrying a SUBQUERY keeps the seed gate', () => {
    // Item 175 gave the seed gate a cheap-conjunct-first order so a faulting subquery is never
    // reached for a vertex the cheap conjunct rejects. A walk evaluating the whole predicate at
    // once loses that, so `rowLocal` refuses the subquery arms here.
    const q =
      "MATCH (a:A)-[:T]->(f:F) WHERE a.name = 'nope' AND EXISTS { MATCH (a)-[:T]->(z) WHERE z.k / 0 > 1 } RETURN f.k AS k";

    expect(query(g, q)).toEqual([]);
  });

  test('a predicate reading BOTH ends still works', () => {
    expect(
      agree('MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 AND f.k = "f2" RETURN f.k AS k'),
    ).toEqual(bag([{ k: 'f2' }]));
  });

  test('a FAR-only predicate still works', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) WHERE f.k = "f2" RETURN f.k AS k')).toEqual(
      bag([{ k: 'f2' }]),
    );
  });

  test('no predicate at all still works', () => {
    expect(agree('MATCH (a:A)-[:T]->(f:F) RETURN f.k AS k').length).toBe(4);
  });

  test('ORDER BY and LIMIT still decline to the general path', () => {
    expect(
      query(g, 'MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN f.k AS k ORDER BY k DESC'),
    ).toEqual([{ k: 'f2' }, { k: 'f1' }]);
    expect(
      query(g, 'MATCH (a:A)-[:T]->(f:F) WHERE a.age > 40 RETURN f.k AS k ORDER BY k LIMIT 1'),
    ).toEqual([{ k: 'f1' }]);
  });
});
