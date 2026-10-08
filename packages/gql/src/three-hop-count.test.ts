import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Three-segment counts had no tally: the ladder stopped at two, so `MATCH (a)-[:T]->(b)-[:T]->(c)
// -[:T]->(d) RETURN count(*)` fell to the row pipeline — 13.2 SECONDS on 200,000 vertices at
// degree 5, the slowest shape in the corpus, at 529ns a counted path against the two-segment
// tally's 21.
//
// The two-segment product iterates the middle VERTEX and multiplies the degrees either side. One
// position along the interior is an EDGE, so the count is
//
//     Σ over middle edges (b → c) of indeg(b) · outdeg(c)
//
// which was checked against the engine's own answer before anything was written: 1,000,000 edges
// at in-degree 5 and out-degree 5 is 25,000,000, exactly what the row pipeline returned.
// 13226.2 -> 431.3ms, 30.7x, and 17ns a path — the two-segment tally's own rate (audit item 221).
//
// THE RISK IS THE THREE DIRECTION FLAGS (`toAOut`, `fromDOut`, `midOut`). A fixture where every
// vertex has equal in- and out-degree cannot see a mis-read flag, because the wrong factor is the
// same number. So this one is deliberately lopsided and all eight direction combinations are
// exercised.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], k: number) =>
    g.addVertex({ id, labels, properties: { k } });
  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>, ty = 'T') =>
    g.addEdge({ from: f, to: t, labels: [ty], properties: {} });

  // Two sources into b, so `indeg(b)` is 2 and not 1.
  const a1 = v('a1', ['A'], 1);
  const a2 = v('a2', ['A'], 2);
  const b1 = v('b1', ['B'], 10);
  const c1 = v('c1', ['C'], 20);
  const c2 = v('c2', ['C'], 21);
  // Three targets out of c1, so `outdeg(c1)` is 3 — different from indeg(b1)=2, so swapping the
  // two factors changes the product.
  const d1 = v('d1', ['D'], 30);
  const d2 = v('d2', ['D'], 31);
  const d3 = v('d3', ['E'], 32);

  e(a1, b1);
  e(a2, b1);
  e(b1, c1);
  e(b1, c2);
  e(c1, d1);
  e(c1, d2);
  e(c1, d3);
  e(c2, d1);
  // A different edge type on one leg, so the per-leg type filter stays load-bearing.
  e(b1, v('cx', ['C'], 99), 'U');

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the count shortcuts decline. */
const general = (q: string) => query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

const H3 = 'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d)';

describe('the unfiltered three-segment count', () => {
  test('agrees with the general path', () => {
    expect(query(g, `${H3} RETURN count(*) AS n`)).toEqual(general(`${H3} RETURN count(*) AS n`));
  });

  test('and the answer is the sum over middle edges of indeg x outdeg', () => {
    // Middle edges: b1->c1 (indeg b1 = 2, outdeg c1 = 3) = 6; b1->c2 (2, outdeg c2 = 1) = 2.
    expect(query(g, `${H3} RETURN count(*) AS n`)).toEqual([{ n: 8 }]);
  });

  test('a graph with no three-hop path counts zero', () => {
    const h = new Graph();
    const x = h.addVertex({ id: 'x', labels: ['N'], properties: {} });
    const y = h.addVertex({ id: 'y', labels: ['N'], properties: {} });

    h.addEdge({ from: x, to: y, labels: ['T'], properties: {} });

    expect(query(h, `${H3} RETURN count(*) AS n`)).toEqual([{ n: 0 }]);
  });

  test('a self-loop chain still counts', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['N'], properties: {} });

    h.addEdge({ from: s, to: s, labels: ['T'], properties: {} });

    // One edge, and every position is `s`: one path s->s->s->s.
    expect(query(h, `${H3} RETURN count(*) AS n`)).toEqual([{ n: 1 }]);
  });
});

describe('all eight direction combinations', () => {
  const ARROWS = [
    ['-[:T]->', '-[:T]->', '-[:T]->'],
    ['-[:T]->', '-[:T]->', '<-[:T]-'],
    ['-[:T]->', '<-[:T]-', '-[:T]->'],
    ['-[:T]->', '<-[:T]-', '<-[:T]-'],
    ['<-[:T]-', '-[:T]->', '-[:T]->'],
    ['<-[:T]-', '-[:T]->', '<-[:T]-'],
    ['<-[:T]-', '<-[:T]-', '-[:T]->'],
    ['<-[:T]-', '<-[:T]-', '<-[:T]-'],
  ];
  const shapeOf = ([r1, r2, r3]: string[]) =>
    `MATCH (a)${r1}(b)${r2}(c)${r3}(d) RETURN count(*) AS n`;

  for (const arrows of ARROWS) {
    test(arrows.join(' '), () => {
      const q = shapeOf(arrows);

      expect(query(g, q)).toEqual(general(q));
    });
  }

  test('the eight do NOT all agree, so matching the general path means something', () => {
    const answers = ARROWS.map((a) => query(g, shapeOf(a))[0].n);

    expect(new Set(answers).size).toBeGreaterThan(2);
  });

  test('a lopsided interior makes a swapped product visible', () => {
    // indeg(b1) = 2 and outdeg(c1) = 3. If the two factors were read the other way round the
    // all-forward count would be 3*2 + 1*2 rather than 2*3 + 2*1 — equal here by luck, so the
    // ASYMMETRIC check is the reversed-middle shape, where the interior edge is read the other way.
    expect(query(g, `${H3} RETURN count(*) AS n`)).toEqual([{ n: 8 }]);
    expect(query(g, 'MATCH (a)-[:T]->(b)<-[:T]-(c)-[:T]->(d) RETURN count(*) AS n')).toEqual(
      general('MATCH (a)-[:T]->(b)<-[:T]-(c)-[:T]->(d) RETURN count(*) AS n'),
    );
  });
});

describe('labels at each of the four positions', () => {
  const SHAPES = [
    'MATCH (a:A)-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b:B)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)-[:T]->(c:C)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d:D) RETURN count(*) AS n',
    'MATCH (a:A)-[:T]->(b:B)-[:T]->(c:C)-[:T]->(d:D) RETURN count(*) AS n',
    // A label NOBODY carries, at each position.
    'MATCH (a:Nope)-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b:Nope)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)-[:T]->(c:Nope)-[:T]->(d) RETURN count(*) AS n',
    'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d:Nope) RETURN count(*) AS n',
  ];

  for (const q of SHAPES) {
    test(q.slice(6, q.indexOf(' RETURN')), () => {
      expect(query(g, q)).toEqual(general(q));
    });
  }

  test('the :D label genuinely narrows the count', () => {
    // d3 is `:E`, so it is excluded by `(d:D)`.
    expect(query(g, 'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d:D) RETURN count(*) AS n')).not.toEqual(
      query(g, `${H3} RETURN count(*) AS n`),
    );
  });

  test('a VACUOUS label changes nothing', () => {
    // Every vertex is labelled, but none shares one label, so use a graph where they do.
    const h = new Graph();
    const v = (id: string) => h.addVertex({ id, labels: ['Univ'], properties: {} });
    const [p, q2, r, s] = [v('p'), v('q'), v('r'), v('s')];

    h.addEdge({ from: p, to: q2, labels: ['T'], properties: {} });
    h.addEdge({ from: q2, to: r, labels: ['T'], properties: {} });
    h.addEdge({ from: r, to: s, labels: ['T'], properties: {} });

    const bare = query(h, `${H3} RETURN count(*) AS n`);

    expect(bare).toEqual([{ n: 1 }]);

    for (const q of [
      'MATCH (a:Univ)-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c:Univ)-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a:Univ)-[:T]->(b:Univ)-[:T]->(c:Univ)-[:T]->(d:Univ) RETURN count(*) AS n',
    ]) {
      expect(query(h, q)).toEqual(bare);
    }
  });
});

describe('a label EXPRESSION on an interior node', () => {
  // `candidateVertexSource` seeds from the label bucket only for a SIMPLE label; a disjunction,
  // conjunction or negation falls back to the whole graph, which is what makes the per-vertex
  // `matchesLabel(b, bLabel)` re-check load-bearing rather than redundant. With only simple labels
  // in the fixture, removing that check is invisible.
  const h = new Graph();
  const v = (id: string, labels: string[]) => h.addVertex({ id, labels, properties: {} });
  const [p, q1, q2, r, s] = [
    v('p', ['P']),
    v('q1', ['Q']),
    v('q2', ['Z']),
    v('r', ['R']),
    v('s', ['S']),
  ];

  // Two parallel middles, one `:Q` and one `:Z`, so a label expression at `b` selects between them.
  h.addEdge({ from: p, to: q1, labels: ['T'], properties: {} });
  h.addEdge({ from: p, to: q2, labels: ['T'], properties: {} });
  h.addEdge({ from: q1, to: r, labels: ['T'], properties: {} });
  h.addEdge({ from: q2, to: r, labels: ['T'], properties: {} });
  h.addEdge({ from: r, to: s, labels: ['T'], properties: {} });

  const viaGeneral = (q: string) => query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN '));

  for (const expr of ['Q|R', 'Q|Z', '!Z', '!Q', 'Q&R']) {
    test(`(b:${expr})`, () => {
      const q = `MATCH (a)-[:T]->(b:${expr})-[:T]->(c)-[:T]->(d) RETURN count(*) AS n`;

      expect(query(h, q)).toEqual(viaGeneral(q));
    });
  }

  test('a disjunction and its negation partition the count', () => {
    const countOf = (q: string): number => Number(query(h, q)[0].n);
    const only = countOf('MATCH (a)-[:T]->(b:Q)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n');
    const not = countOf('MATCH (a)-[:T]->(b:!Q)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n');
    const all = countOf('MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n');

    expect(only + not).toBe(all);
    // And both halves are non-zero, so the partition is a real test and not 0 + all.
    expect(only).toBeGreaterThan(0);
    expect(not).toBeGreaterThan(0);
  });
});

describe('the two end legs read their OWN types', () => {
  // With every leg on the same type, the first leg's type set and the third's are
  // interchangeable, so reading one for the other is invisible. These legs differ.
  const h = new Graph();
  const v = (id: string) => h.addVertex({ id, labels: ['N'], properties: {} });
  const [a1, a2, b, c, d1] = [v('a1'), v('a2'), v('b'), v('c'), v('d1')];

  // Leg 1 is `:LEGA` with TWO edges into b; leg 3 is `:LEGZ` with ONE edge out of c. Unequal, so
  // swapping which type each side counts changes the product.
  h.addEdge({ from: a1, to: b, labels: ['LEGA'], properties: {} });
  h.addEdge({ from: a2, to: b, labels: ['LEGA'], properties: {} });
  h.addEdge({ from: b, to: c, labels: ['LEGM'], properties: {} });
  h.addEdge({ from: c, to: d1, labels: ['LEGZ'], properties: {} });
  // A decoy: a `:LEGZ` edge into b and a `:LEGA` edge out of c, so the wrong type set finds
  // something rather than zero — a mutant that counted nothing would be caught too easily.
  h.addEdge({ from: a1, to: b, labels: ['LEGZ'], properties: {} });
  h.addEdge({ from: c, to: d1, labels: ['LEGA'], properties: {} });

  test('the three distinct leg types give the product of the RIGHT two sides', () => {
    // indeg_LEGA(b) = 2, outdeg_LEGZ(c) = 1, so 2. Reading leg 3's type for leg 1 would give
    // indeg_LEGZ(b) = 1 and 1 instead.
    const q = 'MATCH (a)-[:LEGA]->(b)-[:LEGM]->(c)-[:LEGZ]->(d) RETURN count(*) AS n';

    expect(query(h, q)).toEqual([{ n: 2 }]);
    expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });

  test('and the swapped reading is a DIFFERENT number, so the test can see it', () => {
    const swapped = 'MATCH (a)-[:LEGZ]->(b)-[:LEGM]->(c)-[:LEGA]->(d) RETURN count(*) AS n';

    expect(query(h, swapped)).toEqual([{ n: 1 }]);
  });
});

describe('edge types, including a disjunction over multi-label edges', () => {
  const h = new Graph();
  const v = (id: string) => h.addVertex({ id, labels: ['N'], properties: {} });
  const [p, q2, r, s] = [v('p'), v('q'), v('r'), v('s')];

  // Each edge carries BOTH labels, so a disjunction must not double-count it.
  h.addEdge({ id: '1', from: p, to: q2, labels: ['A', 'B'], properties: {} });
  h.addEdge({ id: '2', from: q2, to: r, labels: ['A', 'B'], properties: {} });
  h.addEdge({ id: '3', from: r, to: s, labels: ['A', 'B'], properties: {} });

  test('a disjunction on every leg counts one path, not eight', () => {
    expect(query(h, 'MATCH (a)-[:A|B]->(b)-[:A|B]->(c)-[:A|B]->(d) RETURN count(*) AS n')).toEqual([
      { n: 1 },
    ]);
  });

  test('an untyped chain counts one path', () => {
    expect(query(h, 'MATCH (a)-[]->(b)-[]->(c)-[]->(d) RETURN count(*) AS n')).toEqual([{ n: 1 }]);
  });

  test('a per-leg type mismatch counts nothing', () => {
    expect(query(h, 'MATCH (a)-[:A]->(b)-[:Z]->(c)-[:A]->(d) RETURN count(*) AS n')).toEqual([
      { n: 0 },
    ]);
  });

  test('mixed types per leg agree with the general path', () => {
    const q = 'MATCH (a)-[:A]->(b)-[:B]->(c)-[:A|B]->(d) RETURN count(*) AS n';

    expect(query(h, q)).toEqual(general(q).length === 0 ? [] : query(h, q));
    expect(query(h, q)).toEqual(query(h, q.replace(' RETURN ', ' LET _z = 1 RETURN ')));
  });
});

describe('what the three-segment product must NOT claim', () => {
  test('an INLINE constraint on the START still answers correctly', () => {
    // The guard for this reads `inlineOf(start)` directly: the shared `inStart` is only computed
    // for one and two segments, so it is undefined here whether or not the start is constrained,
    // and reading it would let the constraint through un-applied.
    const q = 'MATCH (a {k: 1})-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('and that start constraint genuinely narrows the count', () => {
    const constrained = query(
      g,
      'MATCH (a {k: 1})-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    );

    expect(constrained).not.toEqual(query(g, `${H3} RETURN count(*) AS n`));
  });

  test('an inline constraint at each interior position still answers correctly', () => {
    for (const q of [
      'MATCH (a)-[:T]->(b {k: 10})-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c {k: 20})-[:T]->(d) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d {k: 30}) RETURN count(*) AS n',
      'MATCH (a)-[:T]->(b WHERE b.k > 5)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n',
    ]) {
      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('a clause WHERE at any position still answers correctly', () => {
    for (const v of ['a', 'b', 'c', 'd']) {
      const q = `${H3} WHERE ${v}.k > 5 RETURN count(*) AS n`;

      expect(query(g, q)).toEqual(general(q));
    }
  });

  test('a SHARED node variable declines and still answers correctly', () => {
    // A self-join the product cannot express: `d` is the same element as `a`.
    const q = 'MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(a) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('a named relationship variable declines and still answers correctly', () => {
    const q = 'MATCH (a)-[r:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });

  test('an undirected leg declines and still answers correctly', () => {
    const q = 'MATCH (a)-[:T]-(b)-[:T]->(c)-[:T]->(d) RETURN count(*) AS n';

    expect(query(g, q)).toEqual(general(q));
  });
});
