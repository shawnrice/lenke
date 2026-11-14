import { describe, expect, test } from 'bun:test';

/**
 * `MATCH (a)-[:E]->(b), (b)-[:E]->(c)` IS A CHAIN — item 1844.
 *
 * A comma pattern whose start is a variable the previous pattern already ends on is the same walk
 * spelled with a comma, not a product. `spliceChainedPatterns` merges the two so every downstream
 * rewrite and all twenty-odd rungs see one chain: 49.4 ms to 5.4 ms, converging on the arrow
 * spelling's 5.2 ms.
 *
 * ⚠️ TWO KINDS OF ASSERTION HERE, AND BOTH ARE NEEDED.
 *
 *   - ANSWER tests: the spliced spelling must return exactly what the comma spelling returned
 *     BEFORE the rewrite existed. The arrow spelling is the oracle, since the whole claim is that
 *     the two are equivalent.
 *   - A ROUTE test: the rewrite is answer-equivalent BY CONSTRUCTION, so every answer test passes
 *     whether or not it fires — which is how its first version shipped doing nothing at all (the
 *     parser spells the defaults `selector: 'walk'` and `mode: 'trail'` rather than leaving them
 *     `undefined`, so the gate rejected every pattern and the measurement looked like a null
 *     result). `routes()` reads the rungs off `compileLinear`, so it sees the COMPOSED shape —
 *     `rewrite-composition-is-not-free`'s rule: assert that the rewrite's output actually reaches
 *     the rung it was built to reach, rather than trusting that it composes.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/**
 * ⚠️ THE FIXTURE CARRIES A SELF-LOOP AND A 2-CYCLE ON PURPOSE. Splicing turns two patterns into
 * one path, so the questions it can get wrong are all about repeated elements: does the merged
 * chain still allow an edge to be used twice (this engine's fixed-length segments do), and does a
 * repeated VARIABLE still constrain to the existing binding instead of rebinding over it?
 */
const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['T'], properties: { n: id } });
  }

  const edges: [string, string, string][] = [
    ['e0', 'a', 'a'], // self-loop
    ['e1', 'a', 'b'],
    ['e2', 'b', 'a'], // 2-cycle with e1
    ['e3', 'b', 'c'],
    ['e4', 'c', 'd'],
    ['e5', 'd', 'b'],
  ];

  for (const [id, from, to] of edges) {
    const f = g.getVertexById(from);
    const t = g.getVertexById(to);

    if (f === null || t === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id, from: f, to: t, labels: ['E'] });
  }

  return g;
};

const rows = (g: Graph, text: string): string[] =>
  query(g, text)
    .map((r) => Object.values(r).map(String).join('/'))
    .sort();

describe('a comma pattern that continues the previous one', () => {
  test('answers exactly what the arrow spelling answers', () => {
    const g = build();
    const pairs: [string, string][] = [
      [
        'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y',
        'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y',
      ],
      // Three patterns collapse to one in two passes — the fixpoint loop.
      [
        'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T), (c)-[:E]->(d:T) RETURN a.n AS x, d.n AS y',
        'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN a.n AS x, d.n AS y',
      ],
      // A bare anchor with NO segments, continued by the next pattern.
      [
        'MATCH (a:T), (a)-[:E]->(b:T) RETURN a.n AS x, b.n AS y',
        'MATCH (a:T)-[:E]->(b:T) RETURN a.n AS x, b.n AS y',
      ],
      // Carried WHERE and DISTINCT, so the spliced shape reaches item 1843's fusion too.
      [
        'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) WHERE a.n <> c.n RETURN DISTINCT c.n AS x',
        'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) WHERE a.n <> c.n RETURN DISTINCT c.n AS x',
      ],
    ];

    for (const [comma, arrow] of pairs) {
      const got = rows(g, comma);

      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(rows(g, arrow));
    }
  });

  /**
   * ⚠️ A REPEATED VARIABLE MUST STAY A CONSTRAINT. Splicing `(a)-[:E]->(b), (b)-[:E]->(a)` yields
   * `(a)-[:E]->(b)-[:E]->(a)`, whose final node names an already-bound variable. If the chain
   * matcher ever rebinds instead of constraining, this rewrite becomes a wrong answer with no
   * other symptom — so the equivalence is pinned here rather than assumed.
   */
  test('a repeated variable still constrains to the existing binding', () => {
    const g = build();
    const got = rows(g, 'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(a) RETURN a.n AS x, b.n AS y');

    expect(got).toEqual(rows(g, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(a) RETURN a.n AS x, b.n AS y'));
    // a->a->a via the self-loop, plus the a<->b 2-cycle both ways.
    expect(got.length).toBeGreaterThan(0);
  });

  /** The spliced pattern must actually REACH a chain rung, or the rewrite is decorative. */
  test('the spliced shape reaches the same rung as the arrow spelling', () => {
    const comma = routes('MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y');
    const arrow = routes('MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y');

    expect(comma).toEqual(arrow);
    expect(comma.length).toBeGreaterThan(0);
  });

  test('a count over the spliced shape reaches the count shortcut', () => {
    expect(routes('MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN count(*) AS c')).toEqual(
      routes('MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS c'),
    );
  });
});

describe('the splice refuses what it cannot merge', () => {
  /**
   * ⚠️ EACH REFUSAL IS A CORRECTNESS CONDITION, not conservatism, and each is checked by ANSWER —
   * a wrongly-admitted splice shows up as a changed answer, which is the only thing that matters.
   */
  /**
   * ⚠️ THE SECOND PATTERN'S START IS A BARE VARIABLE HERE, AND THAT IS THE WHOLE POINT. The
   * labelled version below cannot reach the join-variable check at all — `bareBackReference`
   * rejects it first — so it passed even with that check mutated away. A mutant that spliced ANY
   * bare-started pattern onto its predecessor turned this four-row product into ZERO rows, and
   * nothing in this file noticed until the mutant was run. An unrelated `(c)` must NOT be merged
   * onto `b` just because it is spelled without a label.
   */
  test('a product whose second pattern starts on an UNRELATED bare variable', () => {
    const g = new Graph();

    for (const id of ['p', 'q', 'r', 's']) {
      g.addVertex({ id, labels: ['T'], properties: { n: id } });
    }

    for (const [id, from, to] of [
      ['x1', 'p', 'q'],
      ['x2', 'r', 's'],
    ] as [string, string, string][]) {
      const f = g.getVertexById(from);
      const t = g.getVertexById(to);

      if (f === null || t === null) {
        throw new Error('fixture is broken');
      }

      g.addEdge({ id, from: f, to: t, labels: ['E'] });
    }

    // Two independent one-hop patterns: a 2x2 product, four rows. Splicing would drop `c`
    // entirely and answer zero.
    expect(rows(g, 'MATCH (a:T)-[:E]->(b:T), (c)-[:E]->(d:T) RETURN a.n AS p, d.n AS q')).toEqual(
      ['p/q', 'p/s', 'r/q', 'r/s'].sort(),
    );
  });

  test('a true product is untouched and still correct', () => {
    const g = build();
    const got = rows(g, 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:E]->(d:T) RETURN b.n AS x, d.n AS y');

    // Six edges, so the product of the two independent hops is 36 rows.
    expect(got.length).toBe(36);
  });

  test('a labelled or constrained joining node does not splice, and still answers', () => {
    const g = build();

    // The joining node carries a label here, so it is not a BARE back-reference. The answer must
    // still match the arrow spelling that states the same constraint.
    expect(rows(g, 'MATCH (a:T)-[:E]->(b:T), (b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y')).toEqual(
      rows(g, 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y'),
    );
  });

  /**
   * ⚠️ A QUANTIFIED SEGMENT IS THE ONE REFUSAL THAT COULD CHANGE ROWS. The default path mode is
   * `trail` (no repeated edge within ONE path), so two patterns carry two restrictors and a merged
   * pattern would carry one across the whole walk.
   */
  test('a var-length segment does not splice, and still answers', () => {
    const g = build();
    const got = rows(g, 'MATCH (a:T)-[:E]->{1,2}(b:T), (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y');

    expect(got.length).toBeGreaterThan(0);
    // The unspliced route is the oracle: a second clause expresses the same question with no
    // comma pattern at all, so it cannot reach the splice.
    expect(got).toEqual(
      rows(g, 'MATCH (a:T)-[:E]->{1,2}(b:T) MATCH (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y'),
    );
  });

  /**
   * ⚠️ THE LABEL ON THE JOINING NODE HAS TO BE SELECTIVE, or the refusal is untestable. The first
   * version of this case ran on an all-`:T` fixture and compared against the arrow spelling, so a
   * mutant that spliced the node and DROPPED its label returned the same rows and survived. Here
   * `m2` is a `:T` that is NOT a `:U`, so dropping `:U` admits a second path.
   */
  test('a labelled joining node does not splice, and its label still filters', () => {
    const g = new Graph();

    g.addVertex({ id: 's', labels: ['T'], properties: { n: 's' } });
    g.addVertex({ id: 'm1', labels: ['T', 'U'], properties: { n: 'm1' } });
    g.addVertex({ id: 'm2', labels: ['T'], properties: { n: 'm2' } });
    g.addVertex({ id: 't', labels: ['T'], properties: { n: 't' } });

    for (const [id, from, to] of [
      ['y0', 's', 'm1'],
      ['y1', 's', 'm2'],
      ['y2', 'm1', 't'],
      ['y3', 'm2', 't'],
    ] as [string, string, string][]) {
      const f = g.getVertexById(from);
      const u = g.getVertexById(to);

      if (f === null || u === null) {
        throw new Error('fixture is broken');
      }

      g.addEdge({ id, from: f, to: u, labels: ['E'] });
    }

    // ⚠️ THE LABEL IS ON THE RIGHT PATTERN'S START ONLY. Writing `(b:U)` on BOTH patterns — the
    // first version of this case — leaves the left one carrying `:U`, so a splice that discards
    // the right start keeps the filter anyway and the mutant survives. Here `(b)` is bare on the
    // left, so `:U` exists nowhere else and dropping it is observable.
    // Only the path through `m1` satisfies `:U`. Dropping the label would answer two rows.
    expect(rows(g, 'MATCH (a:T)-[:E]->(b), (b:U)-[:E]->(c:T) RETURN a.n AS p, c.n AS q')).toEqual([
      's/t',
    ]);
  });

  /**
   * ⚠️ THE PATH VARIABLE MUST BE OBSERVED, not merely present. Returning `a.n, c.n` cannot tell
   * whether `p` bound the first pattern or a merged one — that version survived the mutant.
   * `size(edges(p))` reads the binding directly: unspliced it is 1, and a splice would make it 2.
   */
  test('a path variable keeps binding its OWN pattern', () => {
    const g = build();
    const lengths = rows(
      g,
      'MATCH p = (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN size(edges(p)) AS len',
    );

    expect(lengths.length).toBeGreaterThan(0);
    expect([...new Set(lengths)]).toEqual(['1']);
  });
});
