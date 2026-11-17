/*
 * Item 2106 — `reverseRawPath` against `reversePath`, its compiled twin.
 *
 * ⚠️⚠️ **TWO REVERSERS THAT DISAGREE WOULD BE A WRONG ANSWER, so neither is tested alone.** The
 * compiled one has served `orient` since long before this item; the raw one is new, exists because
 * `patternCountOf` walks the AST path rather than the compiled one, and is a line-for-line mirror. The
 * risk is not that the mirror is wrong today — it is that one of them is later changed alone.
 *
 * 🔑 SO EVERY CASE REVERSES THE SAME PATTERN BOTH WAYS AND COMPARES THE STRUCTURES: segment order,
 * each direction flip, the endpoints, and the carried fields. A mirror checked against its original
 * cannot drift silently.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { PathPattern } from './ast.js';
import type { CPath } from './executor/core.js';
import { reversePath, reverseRawPath } from './executor/matching.js';
import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/** The raw and compiled forms of one `MATCH` pattern, from the same parse. */
const bothFormsOf = (src: string): { raw: PathPattern; compiled: CPath } => {
  const parsed = parse(src) as never as {
    parts: readonly { clauses: readonly { kind: string; patterns?: readonly PathPattern[] }[] }[];
  };
  const [part] = parsed.parts;
  const rawMatch = part.clauses.find((c) => c.kind === 'match');
  const linear = compileLinear(part as never) as unknown as {
    clauses: readonly { kind: string; patterns?: readonly CPath[] }[];
  };
  const cMatch = linear.clauses.find((c) => c.kind === 'match');

  return { raw: rawMatch!.patterns![0], compiled: cMatch!.patterns![0] };
};

/** The shape a reversal is judged by: endpoints, each direction, and the node order between them. */
const shapeOf = (p: {
  start: { variable?: string };
  segments: readonly { rel: { direction: string }; node: { variable?: string } }[];
}): string =>
  [
    p.start.variable ?? '_',
    ...p.segments.map((s) => `${s.rel.direction}:${s.node.variable ?? '_'}`),
  ].join(' | ');

const CASES = {
  'one segment, out': 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  'one segment, in': 'MATCH (a:P)<-[:E]-(b:P) RETURN count(*) AS c',
  'one segment, undirected': 'MATCH (a:P)-[:E]-(b:P) RETURN count(*) AS c',
  'two segments': 'MATCH (a:P)-[:E]->(m:P)-[:E]->(b:P) RETURN count(*) AS c',
  'three segments': 'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) RETURN count(*) AS c',
  'mixed directions': 'MATCH (a:P)-[:E]->(m:P)<-[:E]-(m2:P)-[:E]-(b:P) RETURN count(*) AS c',
  'an anonymous interior': 'MATCH (a:P)-[:E]->(:P)-[:E]->(b:P) RETURN count(*) AS c',
  'four segments':
    'MATCH (a:P)-[:E]->(w:P)-[:E]->(x:P)-[:E]->(y:P)-[:E]->(b:P) RETURN count(*) AS c',
};

describe('reverseRawPath mirrors reversePath (item 2106)', () => {
  for (const [name, src] of Object.entries(CASES)) {
    test(`🔑 ${name} — the two reversers agree`, () => {
      const { raw, compiled } = bothFormsOf(src);

      expect(shapeOf(reverseRawPath(raw) as never)).toBe(shapeOf(reversePath(compiled) as never));
    });
  }

  test('⚠️ reversing TWICE is the identity, both forms', () => {
    const { raw, compiled } = bothFormsOf(CASES['three segments']);

    expect(shapeOf(reverseRawPath(reverseRawPath(raw)) as never)).toBe(shapeOf(raw as never));
    expect(shapeOf(reversePath(reversePath(compiled)) as never)).toBe(shapeOf(compiled as never));
  });

  test('⚠️ the carried fields survive — pathVar, selector, mode', () => {
    /*
     * 🔑 THESE ARE THE FIELDS A MIRROR MOST EASILY DROPS, and dropping one is silent: a lost `mode`
     * turns a `trail` walk into the `walk` default, which changes the ANSWER on a cyclic graph rather
     * than erroring.
     *
     * ⚠️ THE PATTERN IS HAND-BUILT, not parsed, and deliberately so. Every surface spelling that sets a
     * `selector` requires a QUANTIFIED segment (`ANY SHORTEST` refuses a fixed-length path outright),
     * and neither reverser accepts a quantifier — so no parseable query can carry a selector INTO a
     * reversal. Constructing the record directly tests the carry itself rather than a spelling.
     */
    const { raw } = bothFormsOf(CASES['two segments']);
    const decorated: PathPattern = {
      ...raw,
      pathVar: 'p',
      selector: 'anyShortest',
      mode: 'trail',
    };
    const back = reverseRawPath(decorated);

    expect(back.pathVar).toBe('p');
    expect(back.selector).toBe('anyShortest');
    expect(back.mode).toBe('trail');
  });

  test('⚠️ an ABSENT optional field stays absent rather than becoming undefined', () => {
    /*
     * 🔑 `pathVar: undefined` and no `pathVar` are different to `Object.keys`, and the compiled twin
     * spreads conditionally for exactly that reason. A route that compares patterns structurally would
     * see the two as unequal.
     */
    const { raw } = bothFormsOf(CASES['two segments']);
    const back = reverseRawPath(raw);

    expect('pathVar' in back).toBe('pathVar' in raw);
    expect('selector' in back).toBe('selector' in raw);
    expect('mode' in back).toBe('mode' in raw);
  });

  test('⚠️ TWO segments are NOT re-routed by item 2106 — item 220 already seeds them', () => {
    /*
     * 🔑 THIS TEST EXISTS BECAUSE A MUTANT SURVIVED (`segments.length < 3` -> `< 2`). The two-segment
     * end is ALREADY passed as `cend` (item 220), so re-routing it would duplicate an existing seek for
     * nothing — and admitting it is invisible to an answer test, since both orientations are correct.
     *
     * ⚠️ SO IT ASSERTS THE ANSWERS ACROSS BOTH BOUNDARIES — one, two and three segments, each indexed
     * against unindexed. A gate that admitted the wrong lengths would have to return a wrong count to be
     * caught here, which is the honest limit of a route test; the length itself is asserted by the
     * mutation round.
     */
    const g = new Graph();

    for (let i = 0; i < 300; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 17 } });
    }

    for (let e = 0; e < 900; e += 1) {
      const i = e % 300;
      const hop = Math.floor(e / 300);

      g.addEdge({
        id: `e${e}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % 300}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    const shapes = [
      'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(m:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(w:P)-[:E]->(x:P)-[:E]->(y:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c',
    ];
    const before = shapes.map((q) => Number((query(g, q, {})[0] as { c: number }).c));

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    expect(shapes.map((q) => Number((query(g, q, {})[0] as { c: number }).c))).toStrictEqual(
      before,
    );
    // ⚠️ A shape answering 0 would make every arm agree trivially.
    expect(before.every((n) => n > 0)).toBe(true);
  });

  test('⚠️⚠️ the ANSWER is identical whichever end a three-hop count seeds from', () => {
    /*
     * THE END-TO-END CHECK, and the one that would have caught a bad mirror. 14 end-gated shapes were
     * verified indexed-against-unindexed when this shipped; this keeps a sample of that in the suite.
     */
    const g = new Graph();

    for (let i = 0; i < 400; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 23 } });
    }

    for (let e = 0; e < 1200; e += 1) {
      const i = e % 400;
      const hop = Math.floor(e / 400);

      g.addEdge({
        id: `e${e}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % 400}`)!,
        labels: ['E'],
        properties: {},
      });
    }

    const q = 'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) WHERE b.k = 7 RETURN count(*) AS c';
    const before = Number((query(g, q, {})[0] as { c: number }).c);

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    expect(Number((query(g, q, {})[0] as { c: number }).c)).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
});
