import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { LabelExpr } from './ast.js';
import { selectiveFirst } from './executor/shortcuts.js';
import { query } from './index.js';

// The unfiltered two-label hop count walks the edge bucket and keeps an edge when BOTH endpoint
// labels match. The callback's `&&` short-circuits, and the second check DEREFERENCES the other
// endpoint to read its labels — so the order decides how many cold vertex touches the walk pays.
// It tested the START label first, unconditionally, which made two spellings of one question cost
// different amounts. Measured on 200,000 `P` against 2,000 `Q` (audit item 181), medians:
//
//   (a:P)-[:E]->(b:Q)   start is the BIG label    13.38ms -> 11.31ms
//   (b:P)<-[:E]-(a:Q)   start is the BIG label    14.05ms -> 11.00ms
//   (b:Q)<-[:E]-(a:P)   start is the SMALL label  11.34ms    (already fast, unchanged)
//   (a:Q)-[:E]->(b:P)   start is the SMALL label  11.05ms    (already fast, unchanged)
//
// The MIRROR pair identifies the mechanism: not the arrow's direction, but which label lands in
// the first check. A rule of "always test the far end" would move the cost rather than remove it.
//
// Two kinds of assertion. The ANSWER cannot change — both checks must pass either way — so every
// shape is asserted for its count. And the CHOICE has no result-based witness at all, so
// `selectiveFirst` is exported and asserted directly, in pairs differing in one input.

/**
 * `P` is the big label and `Q` the small one, with edges in both directions between them and
 * within `P`, so a count is non-trivial whichever end is tested first. A vertex carrying BOTH
 * labels is included: `matchesLabel` must accept it from either side, and it is the element a
 * reordering could drop.
 */
const skewed = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 20; i++) {
    g.addVertex({ id: `p${i}`, labels: ['P'], properties: { k: i } });
  }

  for (let i = 0; i < 3; i++) {
    g.addVertex({ id: `q${i}`, labels: ['Q'], properties: { k: i } });
  }

  g.addVertex({ id: 'both', labels: ['P', 'Q'], properties: { k: 99 } });

  const v = (id: string) => g.getVertexById(id)!;

  // P -> P within the big label.
  for (let i = 0; i < 19; i++) {
    g.addEdge({
      id: `pp${i}`,
      from: v(`p${i}`),
      to: v(`p${i + 1}`),
      labels: ['E'],
      properties: {},
    });
  }

  // P -> Q, Q -> P, and both directions through the dual-labelled vertex.
  g.addEdge({ id: 'pq0', from: v('p0'), to: v('q0'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'pq1', from: v('p1'), to: v('q1'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'qp0', from: v('q2'), to: v('p5'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'pb', from: v('p3'), to: v('both'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'bp', from: v('both'), to: v('p7'), labels: ['E'], properties: {} });
  // Q -> Q, the edge that makes a DROPPED label check observable: its target is a Q but its
  // source is not a P, so a walk that stopped testing the start label would count it in
  // `(a:P)-[:E]->(b:Q)`. Without it every Q-targeted edge happens to have a P source and the
  // answer is identical either way — a mutant dropping the check survived on that fixture.
  g.addEdge({ id: 'qq0', from: v('q0'), to: v('q1'), labels: ['E'], properties: {} });
  // A second edge type, so the type filter is still observable.
  g.addEdge({ id: 'other', from: v('p0'), to: v('q2'), labels: ['F'], properties: {} });

  return g;
};

const count = (q: string): number => {
  const rows = query(skewed(), q) as Array<{ c: number }>;

  return rows[0].c;
};

const L = (name: string): LabelExpr => ({ kind: 'label', name });

describe('the label checks run selective-first (item 181)', () => {
  test('the four spellings of one question agree on the answer', () => {
    // P -> Q edges of type E: pq0, pq1, and `pb` (p3 -> both, which IS a Q).
    expect(count('MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c')).toBe(3);
    expect(count('MATCH (b:Q)<-[:E]-(a:P) RETURN count(*) AS c')).toBe(3);
    // Q -> P of type E: qp0, and `bp` (both -> p7, and `both` IS a P).
    expect(count('MATCH (a:Q)-[:E]->(b:P) RETURN count(*) AS c')).toBe(2);
    expect(count('MATCH (b:P)<-[:E]-(a:Q) RETURN count(*) AS c')).toBe(2);
  });

  test('a vertex carrying BOTH labels is accepted from either side', () => {
    // `both` is the element a reordering could drop: it is the far end of `pb` and the start of
    // `bp`, and it satisfies P and Q at once.
    expect(count('MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toBe(21);
    // `qq0` is the only Q -> Q edge.
    expect(count('MATCH (a:Q)-[:E]->(b:Q) RETURN count(*) AS c')).toBe(1);
  });

  test('the edge type still filters', () => {
    expect(count('MATCH (a:P)-[:F]->(b:Q) RETURN count(*) AS c')).toBe(1);
    expect(count('MATCH (a:P)-[]->(b:Q) RETURN count(*) AS c')).toBe(4);
  });

  test('an unlabelled endpoint still counts everything on that side', () => {
    // E-type edges whose SOURCE is a P: 19 within P, pq0, pq1, pb, and `bp` (from the
    // dual-labelled vertex, which is a P) = 23. Only `qp0` is excluded.
    expect(count('MATCH (a:P)-[:E]->(b) RETURN count(*) AS c')).toBe(23);
    // E-type edges whose TARGET is a Q: pq0, pq1, pb (the dual-labelled vertex), and qq0.
    expect(count('MATCH (a)-[:E]->(b:Q) RETURN count(*) AS c')).toBe(4);
  });

  test('a label nothing carries counts 0', () => {
    expect(count('MATCH (a:P)-[:E]->(b:Nope) RETURN count(*) AS c')).toBe(0);
    expect(count('MATCH (a:Nope)-[:E]->(b:P) RETURN count(*) AS c')).toBe(0);
  });

  // The choice. Reordering two checks that must both pass changes no row, so this is the only
  // place it is observable — the same escape items 172/173 used for `orient`.
  describe('selectiveFirst, asserted directly', () => {
    const g = skewed();

    test('the SMALLER bucket goes first, either way round', () => {
      // P is 21 vertices (20 plus the dual-labelled one), Q is 4. The pair differs in exactly
      // the order of the two arguments.
      expect(selectiveFirst(g, L('Q'), L('P'))).toBe(true);
      expect(selectiveFirst(g, L('P'), L('Q'))).toBe(false);
    });

    test('an ABSENT far label goes last, because it rejects nobody', () => {
      expect(selectiveFirst(g, L('P'), undefined)).toBe(true);
    });

    test('an ABSENT start label goes last for the same reason', () => {
      expect(selectiveFirst(g, undefined, L('P'))).toBe(false);
    });

    test('neither present: the order cannot matter, and it says so stably', () => {
      expect(selectiveFirst(g, undefined, undefined)).toBe(false);
    });

    test('equal buckets keep the start first, so the choice is deterministic', () => {
      // `<=` rather than `<`: with both ends the same label the walk must not flip-flop.
      expect(selectiveFirst(g, L('P'), L('P'))).toBe(true);
      expect(selectiveFirst(g, L('Q'), L('Q'))).toBe(true);
    });

    test('a label nothing carries is the most selective of all', () => {
      expect(selectiveFirst(g, L('Nope'), L('Q'))).toBe(true);
      expect(selectiveFirst(g, L('Q'), L('Nope'))).toBe(false);
    });
  });
});

// `selectiveFirst`'s own tests prove the CHOICE is right; nothing above proves the walk ASKS it.
// Both call-site mutants (pinning the decision to `true` or to `false`) answer every query
// correctly and survived the first sweep — the wall items 167/168/176 hit. What a reordering
// cannot hide is how many endpoint LABELS it reads: the second check dereferences the other end,
// so the selective order reads far fewer. Counting them is the witness.
describe('the walk really asks selectiveFirst (item 181)', () => {
  /** Total `labels` reads across every vertex during one query. */
  const labelReads = (q: string): number => {
    const g = skewed();
    let reads = 0;

    for (const v of g.vertices) {
      const proto = Object.getPrototypeOf(v) as object;
      const desc = Object.getOwnPropertyDescriptor(proto, 'labels');

      if (desc?.get === undefined) {
        throw new Error('labels is not a prototype getter; this witness needs rewriting');
      }

      // `.bind` immediately, so no unbound method reference is held.
      const read = desc.get.bind(v);

      Object.defineProperty(v, 'labels', {
        configurable: true,
        get: () => {
          reads += 1;

          return read();
        },
      });
    }

    query(g, q);

    return reads;
  };

  test('the asymmetric shape reads the SMALL side first', () => {
    // 25 E edges. Far-first reads 25 target labels, then a start label only for the 4 whose
    // target is a Q. Start-first would read 25 source labels, then a target label for the 23
    // whose source is a P — roughly twice the reads for the same answer.
    const far = labelReads('MATCH (a:P)-[:E]->(b:Q) RETURN count(*) AS c');
    const start = labelReads('MATCH (a:Q)-[:E]->(b:P) RETURN count(*) AS c');

    // Both spellings put the SMALL label (Q, 4 vertices) in the first check, so both stay near
    // one read per edge rather than approaching two.
    expect(far).toBeLessThan(35);
    expect(start).toBeLessThan(35);
  });

  test('CONTROL the same-label shape cannot be helped, and is not harmed', () => {
    // Both ends `P`: the order is immaterial, and the count is whatever one pass costs.
    expect(labelReads('MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c')).toBeGreaterThan(25);
  });

  test('an unlabelled end costs NO reads on that side', () => {
    // `matchesLabel(v, undefined)` is true without touching the vertex, and `selectiveFirst`
    // puts that check last — so the reads are one per edge, not two.
    const reads = labelReads('MATCH (a:P)-[:E]->(b) RETURN count(*) AS c');

    expect(reads).toBeLessThan(35);
  });
});
