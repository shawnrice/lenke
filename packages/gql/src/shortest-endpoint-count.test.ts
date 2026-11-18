/*
 * Item 2151 — `ANY SHORTEST … RETURN count(*)` answered from a BFS's reachable set, with no row built.
 *
 * 🔑 THE ORACLE IS THE ENGINE ITSELF. The rung's projection gate refuses `ORDER BY`, so appending one to
 * the same query forces the general matcher — every arithmetic assertion below compares the two rather
 * than a number I counted. (Item 2146's shape, and items 2133/2146/2149 are why: literals written by eye
 * were wrong three times this session.)
 *
 * ⚠️⚠️ **TWO THINGS HERE WERE CAUGHT BY EXISTING TESTS, NOT BY ME, AND BOTH ARE WRONG ANSWERS.**
 *
 *  1. **Bare `ANY` is NOT this shape.** I admitted `'any'` beside `'anyShortest'` reasoning that one
 *     arbitrary path per endpoint must COUNT the same. ⚠️ `ast.ts` says `'any'` dedups per ENDPOINT and
 *     `'anyShortest'` per endpoint PAIR, so bare `ANY` counts fewer. The rung now requires `anyShortest`.
 *  2. **The SEED is an endpoint when a path returns to it.** `dist` holds the seed at distance 0, so a
 *     self-loop read as already-visited and `(a, a)` went uncounted.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** `ANY SHORTEST` over `{1,max}`, and the same question forced through the general matcher. */
const both = (g: Graph, q: string): { rung: unknown; general: unknown } => ({
  rung: query(g, q)[0]?.c,
  general: query(g, `${q} ORDER BY c`)[0]?.c,
});

const AS = (max: number, dir: 'out' | 'in' = 'out', far = ':P'): string =>
  `MATCH ANY SHORTEST (a:P)${dir === 'out' ? '-[:T]->' : '<-[:T]-'}{1,${max}}(b${far}) RETURN count(*) AS c`;

/** A chain `v0 → v1 → v2 → v3` with a shortcut `v0 → v3`, a back edge `v3 → v0`, and a self-loop on v1. */
const chain = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 4; i += 1) {
    g.addVertex({ id: `v${i}`, labels: i === 2 ? ['P', 'Q'] : ['P'], properties: { k: i } });
  }

  const e = (id: string, from: string, to: string, label = 'T'): void =>
    void g.addEdge({
      id,
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: [label],
      properties: { w: 1 },
    });

  e('c0', 'v0', 'v1');
  e('c1', 'v1', 'v2');
  e('c2', 'v2', 'v3');
  e('short', 'v0', 'v3');
  e('back', 'v3', 'v0');
  e('loop', 'v1', 'v1'); // ⚠️ the self-loop — see note 2 in the header
  e('u0', 'v0', 'v2', 'U'); // a second edge label, for the typed walk to exclude

  return g;
};

describe('the ANY SHORTEST endpoint count (item 2151)', () => {
  describe('🔑 the rung agrees with the general matcher', () => {
    test.each([[1], [2], [3], [4], [8]])('depth 1-%i', (max) => {
      const { rung, general } = both(chain(), AS(max));

      expect(rung).toBe(general);
    });

    test('⚠️ the INCOMING direction', () => {
      const { rung, general } = both(chain(), AS(3, 'in'));

      expect(rung).toBe(general);
    });

    test('⚠️ a SELECTIVE far label narrows the endpoints', () => {
      const g = chain();
      const { rung, general } = both(g, AS(3, 'out', ':Q'));

      expect(rung).toBe(general);
      // ⚠️ And it must actually narrow, or the test is vacuous: only v2 is a Q.
      expect(rung).not.toBe(query(g, AS(3))[0].c);
    });

    test('⚠️ NO far label at all', () => {
      const { rung, general } = both(chain(), AS(3, 'out', ''));

      expect(rung).toBe(general);
    });

    test('an EMPTY graph counts zero', () => {
      const { rung, general } = both(new Graph(), AS(3));

      expect(rung).toBe(general);
      expect(rung).toBe(0);
    });

    test('a graph with no edge of that type counts zero', () => {
      const g = new Graph();

      g.addVertex({ id: 'x', labels: ['P'], properties: {} });
      g.addVertex({ id: 'y', labels: ['P'], properties: {} });
      g.addEdge({
        id: 'other',
        from: g.getVertexById('x')!,
        to: g.getVertexById('y')!,
        labels: ['OTHER'],
        properties: {},
      });

      expect(both(g, AS(3)).rung).toBe(0);
    });
  });

  describe('⚠️⚠️ the SELF-LOOP — the wrong answer an existing test caught', () => {
    test('a vertex reached by its own loop is counted once', () => {
      /*
       * 🔑 v1 has a self-loop, so `(v1, v1)` is a legitimate endpoint pair at distance 1. ⚠️ Before the
       * fix, `dist` already held v1 at distance 0 and the loop read as visited, so the pair went
       * uncounted — silently, with every other pair right.
       */
      const g = new Graph();

      g.addVertex({ id: 'a', labels: ['P'], properties: {} });
      g.addVertex({ id: 'b', labels: ['P'], properties: {} });
      g.addEdge({
        id: 'self',
        from: g.getVertexById('a')!,
        to: g.getVertexById('a')!,
        labels: ['T'],
        properties: {},
      });
      g.addEdge({
        id: 'ab',
        from: g.getVertexById('a')!,
        to: g.getVertexById('b')!,
        labels: ['T'],
        properties: {},
      });

      const { rung, general } = both(g, AS(3));

      expect(rung).toBe(general);
      // (a,a) via the loop and (a,b) via `ab` — two pairs. ⚠️ The pre-fix answer was 1.
      expect(rung).toBe(2);
    });

    test('⚠️ and a CYCLE back to the seed, at the distance it closes', () => {
      // v0 → v3 → v0: the pair (v0, v0) appears from depth 2 up, and not at depth 1.
      const g = chain();

      expect(both(g, AS(1)).rung).toBe(both(g, AS(1)).general);
      expect(Number(both(g, AS(2)).rung)).toBeGreaterThan(Number(both(g, AS(1)).rung));
    });
  });

  describe('⚠️⚠️ the semantics that make this its OWN rung', () => {
    test('on a diamond, ANY SHORTEST and the plain walk DISAGREE', () => {
      /*
       * 🔑 THE MEASUREMENT THAT SETTLED ITEM 2150's QUESTION. `a→b→d` and `a→c→d` at `{1,2}`:
       * `ANY SHORTEST` keeps one path per endpoint pair, so it counts 3 (b, c, d); the default `walk`
       * counts PATHS, so it counts 4. ⚠️ Which is why the existing reachability rung refusing a selector
       * is CORRECT, and why this rung cannot simply be routed there.
       */
      const g = new Graph();

      for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
        g.addVertex({ id, labels: ['P'], properties: { k: i } });
      }

      let n = 0;

      for (const [f, t] of [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ] as const) {
        g.addEdge({
          id: `e${(n += 1)}`,
          from: g.getVertexById(f)!,
          to: g.getVertexById(t)!,
          labels: ['T'],
          properties: {},
        });
      }

      /*
       * ⚠️ DERIVED OVER ALL FOUR SEEDS, which is where I first got this wrong — I carried over the 3 and
       * 4 from a probe that had a `WHERE` pinning the seed to `a`.
       *
       *     ANY SHORTEST: a→{b,c,d} = 3,  b→{d} = 1,  c→{d} = 1,  d→{} = 0   ⇒ 5
       *     walk:         a→b, a→c, a→b→d, a→c→d = 4,  b→d = 1,  c→d = 1     ⇒ 6
       */
      const anyShortest = query(
        g,
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) RETURN count(*) AS c',
      );
      const walk = query(g, 'MATCH (a:P)-[:T]->{1,2}(b:P) RETURN count(*) AS c');

      expect(anyShortest[0].c).toBe(5);
      expect(walk[0].c).toBe(6);
      // 🔑 THE CLAIM: the two spellings answer DIFFERENTLY, so one rung cannot serve both.
      expect(anyShortest[0].c).not.toBe(walk[0].c);

      // And with the seed pinned to `a` (k = 0), the gap is the diamond's two routes to `d`: 3 vs 4.
      // ⚠️ `a.id` is NOT a property read in ISO-GQL, which is how this assertion first read 0.
      expect(
        query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) WHERE a.k = 0 RETURN count(*) AS c')[0]
          .c,
      ).toBe(3);
      expect(query(g, 'MATCH (a:P)-[:T]->{1,2}(b:P) WHERE a.k = 0 RETURN count(*) AS c')[0].c).toBe(
        4,
      );
    });

    test('⚠️ PARALLEL edges collapse to one endpoint pair', () => {
      const g = new Graph();

      g.addVertex({ id: 'a', labels: ['P'], properties: {} });
      g.addVertex({ id: 'b', labels: ['P'], properties: {} });

      for (const w of [1, 2, 3]) {
        g.addEdge({
          id: `p${w}`,
          from: g.getVertexById('a')!,
          to: g.getVertexById('b')!,
          labels: ['T'],
          properties: { w },
        });
      }

      const { rung, general } = both(g, AS(3));

      expect(rung).toBe(general);
      // One pair (a, b), however many edges join them. ⚠️ The walk form counts 3.
      expect(rung).toBe(1);
      expect(query(g, 'MATCH (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c')[0].c).toBe(3);
    });
  });

  describe('⚠️ every decline still answers, through the general matcher', () => {
    test.each([
      [
        'a clause WHERE',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = 0 RETURN count(*) AS c',
      ],
      ['ALL SHORTEST', 'MATCH ALL SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c'],
      ['bare ANY', 'MATCH ANY (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c'],
      ['no selector at all', 'MATCH (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c'],
      ['an UNBOUNDED max', 'MATCH ANY SHORTEST (a:P)-[:T]->{1,}(b:P) RETURN count(*) AS c'],
      ['a path VARIABLE', 'MATCH p = ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c'],
      [
        'an inline property',
        'MATCH ANY SHORTEST (a:P {k: 0})-[:T]->{1,3}(b:P) RETURN count(*) AS c',
      ],
      ['a REL variable', 'MATCH ANY SHORTEST (a:P)-[e:T]->{1,3}(b:P) RETURN count(*) AS c'],
      ['a BOTH direction', 'MATCH ANY SHORTEST (a:P)-[:T]-{1,3}(b:P) RETURN count(*) AS c'],
      ['DISTINCT', 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN DISTINCT count(*) AS c'],
      ['a LIMIT', 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c LIMIT 1'],
      ['a GROUP BY', 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN a.k AS g, count(*) AS c'],
    ])('%s', (_name, q) => {
      // 🔑 Not an assertion about speed — that a declined shape still ANSWERS, and does not throw.
      expect(() => query(chain(), q)).not.toThrow();
    });
  });

  describe('⚠️⚠️ the two quantifier gates, on fixtures that can SEE them', () => {
    /**
     * A chain of 7 vertices, `v0 → v1 → … → v6`, so an unbounded walk reaches further than any bounded
     * one. 🔑 On a SATURATED graph `{1,}` and `{1,3}` coincide, which is exactly how the unbounded gate's
     * mutant first survived.
     */
    const line = (): Graph => {
      const g = new Graph();

      for (let i = 0; i < 7; i += 1) {
        g.addVertex({ id: `n${i}`, labels: ['P'], properties: { k: i } });
      }

      for (let i = 0; i < 6; i += 1) {
        g.addEdge({
          id: `l${i}`,
          from: g.getVertexById(`n${i}`)!,
          to: g.getVertexById(`n${i + 1}`)!,
          labels: ['T'],
          properties: {},
        });
      }

      return g;
    };

    test('⚠️⚠️ an UNBOUNDED max reaches further than a bounded one', () => {
      /*
       * 🔑 Down a 6-edge line the reachable-pair counts are 6+5+4+3+2+1 = 21 unbounded, against
       * 3+3+3+3+2+1 = 15 at `{1,3}`. ⚠️ A rung that ADMITTED the unbounded form would walk `depth < null`,
       * which is false at once — answering 0. The bounded number is what the general matcher gives.
       */
      const g = line();

      expect(query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,}(b:P) RETURN count(*) AS c')[0].c).toBe(
        21,
      );
      expect(query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c')[0].c).toBe(
        15,
      );
    });

    test('⚠️⚠️ a MIN of 0 includes the zero-length path, and the rung must decline it', () => {
      /*
       * 🔑 `{0,n}` admits the empty path, so every vertex is its own endpoint — 15 bounded pairs + 7 self = 22 at `{0,3}`.
       * ⚠️ This rung's BFS starts at depth 1 and would answer 15 for `{0,3}`, so the `min < 1` gate is
       * LOAD-BEARING. ⚠️ `min > 1` cannot be tested at all: `{2,4}` with a selector is `E_SYNTAX`.
       */
      const g = line();

      expect(query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{0,3}(b:P) RETURN count(*) AS c')[0].c).toBe(
        22,
      );
      expect(() =>
        query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{2,4}(b:P) RETURN count(*) AS c'),
      ).toThrow();
    });
  });

  describe('⚠️⚠️ the START GATE (item 2152), and the spelling pair it had to keep together', () => {
    test('a clause WHERE agrees with the general matcher', () => {
      const g = chain();
      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = 0 RETURN count(*) AS c';

      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
    });

    test('⚠️⚠️ the INLINE spelling answers the same as the clause spelling', () => {
      /*
       * 🔑 THE REGRESSION THIS FILE EXISTS TO CATCH. `(a:P {k: 0})` means exactly `WHERE a.k = 0`. When
       * item 2152 first admitted only the clause form, the two measured **8.24 ms against 27.52** — 3.3x
       * apart for one question, the defect class this repo is organised around, opened by that change.
       * ⚠️ They converged to 8.57 / 9.73 once `gateWith` was allowed to fold the node's own properties.
       */
      const g = chain();
      const clause = query(
        g,
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = 0 RETURN count(*) AS c',
      );
      const inline = query(
        g,
        'MATCH ANY SHORTEST (a:P {k: 0})-[:T]->{1,3}(b:P) RETURN count(*) AS c',
      );

      expect(inline[0].c).toBe(clause[0].c);
      // ⚠️ And non-vacuous: the unfiltered question answers more.
      expect(Number(clause[0].c)).toBeLessThan(Number(query(g, AS(3))[0].c));
    });

    test('BOTH spellings at once compose', () => {
      const g = chain();
      const q =
        'MATCH ANY SHORTEST (a:P {k: 0})-[:T]->{1,3}(b:P) WHERE a.k >= 0 RETURN count(*) AS c';

      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
    });

    test('several conjuncts on the start', () => {
      const g = chain();
      const q =
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k >= 0 AND a.k < 2 RETURN count(*) AS c';

      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
    });

    test('a $param in the gate', () => {
      /*
       * ⚠️ A LINE, NOT THE CHAIN FIXTURE. On the chain, seeds k = 0 and k = 1 BOTH reach 4 endpoints
       * within 3 hops — a coincidence that made the "different param, different answer" assertion fail
       * while the engine was right. 🔑 Down a line the seed's POSITION decides the count: n0 reaches 3,
       * n4 reaches 2.
       */
      const g = new Graph();

      for (let i = 0; i < 6; i += 1) {
        g.addVertex({ id: `n${i}`, labels: ['P'], properties: { k: i } });
      }

      for (let i = 0; i < 5; i += 1) {
        g.addEdge({
          id: `l${i}`,
          from: g.getVertexById(`n${i}`)!,
          to: g.getVertexById(`n${i + 1}`)!,
          labels: ['T'],
          properties: {},
        });
      }

      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = $k RETURN count(*) AS c';

      expect(query(g, q, { k: 0 })[0].c).toBe(3);
      expect(query(g, q, { k: 4 })[0].c).toBe(1);
      // 🔑 The gate is read per CALL, not baked into the closure, and both agree with the general path.
      expect(query(g, q, { k: 0 })[0].c).toBe(query(g, `${q} ORDER BY c`, { k: 0 })[0].c);
      expect(query(g, q, { k: 4 })[0].c).toBe(query(g, `${q} ORDER BY c`, { k: 4 })[0].c);
    });

    test('⚠️⚠️ a gate that is TRUE for one seed must not leak to the next', () => {
      /*
       * 🔑 ONE binding Map is reused across every seed, which is the habit this engine keeps — and the
       * risk it carries. ⚠️ With three seeds where only the middle one passes, a leak shows up as a count
       * that is too high.
       */
      const g = new Graph();

      for (let i = 0; i < 3; i += 1) {
        g.addVertex({ id: `s${i}`, labels: ['P'], properties: { k: i } });
        g.addEdge({
          id: `t${i}`,
          from: g.getVertexById(`s${i}`)!,
          to: g.getVertexById('s0')!,
          labels: ['T'],
          properties: {},
        });
      }

      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) WHERE a.k = 1 RETURN count(*) AS c';

      // Only s1 passes; it reaches s0 in one hop, and s0's own edge is a self-loop so nothing further.
      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
      expect(query(g, q)[0].c).toBe(1);
    });

    test.each([
      [
        'a FAR-side WHERE',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE b.k = 1 RETURN count(*) AS c',
      ],
      [
        'a conjunct on EACH side',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = 0 AND b.k = 2 RETURN count(*) AS c',
      ],
      [
        'a FAR inline property',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P {k: 2}) RETURN count(*) AS c',
      ],
      [
        'an OR across the two',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = 0 OR b.k = 2 RETURN count(*) AS c',
      ],
      /*
       * ⚠️⚠️ A CORRELATED INLINE VALUE reaches this rung's gate — the start's inline properties ARE
       * admitted — and `gateWith` answers `null` for it, which is NEITHER a predicate nor `undefined`.
       * 🔑 Without the `startPred === null` check, `inlineHolds` would be handed `null` and THROW on
       * `ip.bindVar`. A mutation survived until this case existed.
       */
      [
        'a CORRELATED inline value',
        'MATCH ANY SHORTEST (a:P {k: b.k})-[:T]->{1,3}(b:P) RETURN count(*) AS c',
      ],
      [
        'a WHERE correlating both variables',
        'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) WHERE a.k = b.k RETURN count(*) AS c',
      ],
    ])('⚠️ %s still DECLINES and still answers', (_name, q) => {
      const g = chain();

      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
    });
  });

  describe('⚠️⚠️ the VACUOUS far-label elision (item 2153)', () => {
    /** Three `P` vertices in a line; `extra` optionally adds a vertex WITHOUT the `P` label. */
    const lineOf = (extraUnlabelled: boolean): Graph => {
      const g = new Graph();

      for (let i = 0; i < 4; i += 1) {
        g.addVertex({ id: `w${i}`, labels: ['P'], properties: { k: i } });
      }

      if (extraUnlabelled) {
        g.addVertex({ id: 'odd', labels: ['R'], properties: { k: 9 } });
      }

      for (let i = 0; i < 3; i += 1) {
        g.addEdge({
          id: `m${i}`,
          from: g.getVertexById(`w${i}`)!,
          to: g.getVertexById(`w${i + 1}`)!,
          labels: ['T'],
          properties: {},
        });
      }

      if (extraUnlabelled) {
        g.addEdge({
          id: 'modd',
          from: g.getVertexById('w0')!,
          to: g.getVertexById('odd')!,
          labels: ['T'],
          properties: {},
        });
      }

      return g;
    };

    test('a VACUOUS label answers as NO label does', () => {
      // 🔑 Every vertex is a P, so `(b:P)` cannot reject anything — the two spellings must agree.
      const g = lineOf(false);

      expect(query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c')[0].c).toBe(
        query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b) RETURN count(*) AS c')[0].c,
      );
    });

    test('⚠️⚠️ a MIXED graph still RUNS the test — the two spellings DIVERGE', () => {
      /*
       * 🔑 THE ASSERTION THAT MAKES THE ELISION SAFE. With one `R` vertex reachable, `(b:P)` rejects it
       * and `(b)` does not, so the answers MUST differ. ⚠️ An elision that fired here would silently
       * count the `R` as a `P`.
       */
      const g = lineOf(true);
      const labelled = query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c');
      const bare = query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b) RETURN count(*) AS c');

      expect(labelled[0].c).not.toBe(bare[0].c);
      expect(labelled[0].c).toBe(
        query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c ORDER BY c')[0].c,
      );
    });

    test('⚠️⚠️ a WRITE that ENDS the vacuity, between two asks', () => {
      /*
       * 🔑 THE REASON VACUITY IS COMPUTED PER CALL, NOT PER COMPILE. Both asks share a query TEXT, so
       * the plan cache hands back the same closure; adding a vertex without the label must make the
       * test start running again.
       */
      const g = lineOf(false);
      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P) RETURN count(*) AS c';
      const before = Number(query(g, q)[0].c);

      g.addVertex({ id: 'later', labels: ['R'], properties: { k: 7 } });
      g.addEdge({
        id: 'mlater',
        from: g.getVertexById('w0')!,
        to: g.getVertexById('later')!,
        labels: ['T'],
        properties: {},
      });

      // ⚠️ `later` is reachable but is NOT a P, so the count must be unchanged — not `before + 1`.
      expect(query(g, q)[0].c).toBe(before);
      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
      // And the bare spelling DOES see it, which proves the new vertex is genuinely reachable.
      expect(
        Number(query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b) RETURN count(*) AS c')[0].c),
      ).toBe(before + 1);
    });

    test('⚠️ a COMPOSITE label expression is NOT treated as vacuous', () => {
      /*
       * 🔑 `farLabelIsVacuous` reads only the single `label` kind; `matchesLabel` owns composite logic,
       * and duplicating it to save a call is how a vacuity check becomes a wrong answer.
       */
      const g = lineOf(true);
      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,3}(b:P|R) RETURN count(*) AS c';

      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
    });
  });

  describe('⚠️⚠️ the IDENTITY-keyed seen set (item 2154)', () => {
    test('a vertex reached by TWO paths is counted once', () => {
      /*
       * 🔑 THE DEDUP, which is the whole reason the set exists. A diamond reaches `d` two ways; keyed on
       * identity it must still be one endpoint pair. ⚠️ If `edge.to` ever returned a fresh wrapper per
       * access, this is the assertion that would fail — a WRONG ANSWER, not a slow path.
       */
      const g = new Graph();

      for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
        g.addVertex({ id, labels: ['P'], properties: { k: i } });
      }

      let n = 0;

      for (const [f, t] of [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ] as const) {
        g.addEdge({
          id: `d${(n += 1)}`,
          from: g.getVertexById(f)!,
          to: g.getVertexById(t)!,
          labels: ['T'],
          properties: {},
        });
      }

      // From `a` alone: b, c, d — three pairs, with `d` NOT double counted.
      expect(
        query(g, 'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) WHERE a.k = 0 RETURN count(*) AS c')[0]
          .c,
      ).toBe(3);
    });

    test('⚠️ the SEED comparison is identity too', () => {
      /*
       * 🔑 `nbr === seed` replaced `nbr.id === seed.id`. A cycle back to the seed must still be found,
       * and found ONCE.
       */
      const g = new Graph();

      g.addVertex({ id: 'p', labels: ['P'], properties: { k: 0 } });
      g.addVertex({ id: 'q', labels: ['P'], properties: { k: 1 } });
      g.addEdge({
        id: 'pq',
        from: g.getVertexById('p')!,
        to: g.getVertexById('q')!,
        labels: ['T'],
        properties: {},
      });
      g.addEdge({
        id: 'qp',
        from: g.getVertexById('q')!,
        to: g.getVertexById('p')!,
        labels: ['T'],
        properties: {},
      });

      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) WHERE a.k = 0 RETURN count(*) AS c';

      // From `p`: q at 1, then p itself at 2 — two pairs.
      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
      expect(query(g, q)[0].c).toBe(2);
    });

    test('⚠️ a vertex ADDED between asks is a distinct key', () => {
      /*
       * 🔑 A fresh vertex object must not collide with an existing one, and must be recognised as
       * already-seen within the walk that reaches it.
       */
      const g = new Graph();

      g.addVertex({ id: 'r0', labels: ['P'], properties: { k: 0 } });
      g.addVertex({ id: 'r1', labels: ['P'], properties: { k: 1 } });
      g.addEdge({
        id: 'r01',
        from: g.getVertexById('r0')!,
        to: g.getVertexById('r1')!,
        labels: ['T'],
        properties: {},
      });

      const q = 'MATCH ANY SHORTEST (a:P)-[:T]->{1,2}(b:P) RETURN count(*) AS c';

      expect(query(g, q)[0].c).toBe(1);

      g.addVertex({ id: 'r2', labels: ['P'], properties: { k: 2 } });
      g.addEdge({
        id: 'r12',
        from: g.getVertexById('r1')!,
        to: g.getVertexById('r2')!,
        labels: ['T'],
        properties: {},
      });

      // r0→r1, r0→r1→r2, r1→r2 — three pairs.
      expect(query(g, q)[0].c).toBe(query(g, `${q} ORDER BY c`)[0].c);
      expect(query(g, q)[0].c).toBe(3);
    });
  });

  test('⚠️ a WRITE between two asks is reflected', () => {
    /*
     * 🔑 The rung reads `graph` at RUN time, never at compile time, and both asks share a query TEXT so
     * the plan cache hands back the same closure.
     */
    const g = chain();
    const before = Number(query(g, AS(3))[0].c);

    g.addVertex({ id: 'fresh', labels: ['P'], properties: { k: 9 } });
    g.addEdge({
      id: 'newedge',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('fresh')!,
      labels: ['T'],
      properties: {},
    });

    const after = query(g, AS(3));

    expect(after[0].c).toBe(query(g, `${AS(3)} ORDER BY c`)[0].c);
    expect(Number(after[0].c)).toBeGreaterThan(before);
  });
});
