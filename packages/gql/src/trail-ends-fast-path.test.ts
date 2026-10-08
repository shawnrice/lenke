import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import type { PathMode, RelPattern } from './ast.js';
import { compileRel } from './executor.js';
import { trailEnds, trailEndsViaUnit } from './executor/matching.js';
import { parse } from './parser.js';

// Item 239. `trailEnds` answered the abbreviated `-[]->{n,m}` form through the general nested-unit
// matcher, which costs 7.82us an outer row where a hand-written walk of the same question costs
// 0.82 (audit item 237). It now takes a flat walk when no path reconstruction is wanted, and keeps
// the general matcher for `wantPath` and as `trailEndsViaUnit`.
//
// THE EMISSION SEQUENCE IS THE CONTRACT, not the set of ends. A caller may count, dedup, or take
// the first — and row order for an unordered query is unspecified only BETWEEN runs of the same
// engine, not between two implementations that are supposed to be the same one. So these compare
// the two paths element by element, across every mode, bound and direction.
const build = (): Graph => {
  const g = new Graph();
  const v: Record<string, Vertex> = {};

  for (const id of ['1', '2', '3', '4', '5']) {
    v[id] = g.addVertex({ id, labels: ['T'], properties: { n: Number(id) } });
  }

  // A CYCLE (1 -> 2 -> 3 -> 1) so trail/simple/acyclic/walk are distinguishable, a second in-edge
  // into 3 so a vertex has branching, a parallel edge 1 -> 2 so TRAIL (which marks edges) and
  // SIMPLE (which marks vertices) disagree, and a self-loop on 4.
  const e = (id: string, from: string, to: string, w: number): void => {
    g.addEdge({ id, labels: ['E'], from: v[from], to: v[to], properties: { w } });
  };

  e('a', '1', '2', 1);
  e('b', '2', '3', 2);
  e('c', '3', '1', 3);
  e('d', '1', '3', 4);
  e('e', '1', '2', 5); // parallel to `a`
  e('f', '3', '4', 6);
  e('g', '4', '4', 7); // self-loop
  e('h', '4', '5', 8);

  return g;
};

const MODES: PathMode[] = ['walk', 'trail', 'simple', 'acyclic'];
const QUANTS = ['{0,2}', '{1,1}', '{1,2}', '{1,3}', '{2,2}', '{2,3}', '{0,3}', '+'];
const HOPS = ['-[:E]->', '<-[:E]-', '-[r:E WHERE r.w > 2]->'];

/**
 * The COMPILED rel for one abbreviated pattern, run through the real parser and the real
 * `compileRel` rather than hand-built — a hand-built `CRel` would test this file's idea of one,
 * and the per-hop predicate in particular is compiled rather than literal.
 */
const relOf = (
  hop: string,
  quant: string,
): { rel: ReturnType<typeof compileRel>; q: { min: number; max: number | null } } => {
  const stmt = parse(`MATCH (a:T)${hop}${quant}(b) RETURN count(*) AS c`) as unknown as {
    parts: { clauses: { patterns: { segments: { rel: RelPattern }[] }[] }[] }[];
  };
  const astRel = stmt.parts[0].clauses[0].patterns[0].segments[0].rel;
  const rel = compileRel(astRel);

  return { rel, q: rel.quantifier as { min: number; max: number | null } };
};

describe('the flat walk and the general matcher agree, element by element', () => {
  const g = build();
  const seeds = ['1', '2', '3', '4', '5'];

  for (const mode of MODES) {
    for (const quant of QUANTS) {
      // WALK with an unbounded `+` over a cycle terminates only on the trail budget, which is a
      // resource limit rather than an answer — the same reason the fuzzer pairs a mode only with a
      // bounded quantifier (item 238).
      if (mode === 'walk' && quant === '+') {
        continue;
      }

      test(`${mode} ${quant}`, () => {
        for (const hop of HOPS) {
          const { rel, q } = relOf(hop, quant);

          for (const id of seeds) {
            const from = g.getVertexById(id) as Vertex;
            const opts = { mode, binding: new Map<string, unknown>(), params: {} };

            const fast = [...trailEnds(g, from, rel, q, opts)].map((t) => t.end.id);
            const general = [...trailEndsViaUnit(g, from, rel, q, opts)].map((t) => t.end.id);

            // SEQUENCE equality, not set equality.
            expect({ mode, quant, hop, id, ends: fast }).toEqual({
              mode,
              quant,
              hop,
              id,
              ends: general,
            });
          }
        }
      });
    }
  }
});

describe('the cases the fast path declines', () => {
  const g = build();

  test('wantPath keeps the general matcher, and the path is still built', () => {
    const { rel, q } = relOf('-[:E]->', '{1,2}');
    const from = g.getVertexById('1') as Vertex;
    const opts = { mode: 'trail' as PathMode, binding: new Map<string, unknown>(), params: {} };

    const withPath = [...trailEnds(g, from, rel, q, { ...opts, wantPath: true })];

    // A flat walk yields empty `verts`/`edges`; this must not.
    expect(withPath.every((t) => t.verts.length > 0 && t.edges.length > 0)).toBe(true);
    expect(withPath.map((t) => t.end.id)).toEqual(
      [...trailEndsViaUnit(g, from, rel, q, { ...opts, wantPath: true })].map((t) => t.end.id),
    );
  });

  test('without wantPath BOTH paths yield empty verts/edges', () => {
    const { rel, q } = relOf('-[:E]->', '{1,2}');
    const from = g.getVertexById('1') as Vertex;
    const opts = { mode: 'trail' as PathMode, binding: new Map<string, unknown>(), params: {} };

    for (const t of trailEnds(g, from, rel, q, opts)) {
      expect([t.verts.length, t.edges.length, t.steps.length]).toEqual([0, 0, 0]);
    }
  });
});

describe('the STEP budget is accounted the same way', () => {
  // The one thing the sequence comparison cannot see. Extending one repetition PAST `max` emits
  // nothing — the emit test fails at `max + 1` — so a fast path that descends too far returns the
  // identical sequence and merely does more work. The difference is observable only in `steps`,
  // because each extra hop is charged against `graph.limits.trail`.
  //
  // `resolve` offers a further repetition only when `rep < max`, so the general matcher never
  // reaches that depth. Mutation found this: the `< max` -> `<= max` mutant survived the whole
  // sequence comparison until this test existed (audit item 239).
  const budgeted = (trail: number): Graph => {
    const g = new Graph({ limits: { trail } });
    const v: Record<string, Vertex> = {};

    for (const id of ['1', '2', '3', '4']) {
      v[id] = g.addVertex({ id, labels: ['T'], properties: { n: Number(id) } });
    }

    // A fan at each level, so the hop count climbs quickly and a tight budget bites.
    for (const [id, from, to] of [
      ['a', '1', '2'],
      ['b', '1', '3'],
      ['c', '2', '3'],
      ['d', '2', '4'],
      ['e', '3', '4'],
      ['f', '4', '1'],
    ] as const) {
      g.addEdge({ id, labels: ['E'], from: v[from], to: v[to], properties: { w: 1 } });
    }

    return g;
  };

  test('both paths spend the same budget, so both raise at the same ceiling', () => {
    const { rel, q } = relOf('-[:E]->', '{1,2}');

    // Find the smallest budget at which the GENERAL matcher completes, then require the fast path
    // to complete there too. A fast path that walks one level too deep spends more and raises.
    for (const trail of [3, 4, 5, 6, 8, 12, 20]) {
      const g = budgeted(trail);
      const from = g.getVertexById('1') as Vertex;
      const opts = { mode: 'trail' as const, binding: new Map<string, unknown>(), params: {} };

      const ran = (fn: () => unknown[]): { ok: boolean; ends: unknown[] } => {
        try {
          return { ok: true, ends: fn() };
        } catch {
          return { ok: false, ends: [] };
        }
      };

      const fast = ran(() => [...trailEnds(g, from, rel, q, opts)].map((t) => t.end.id));
      const general = ran(() => [...trailEndsViaUnit(g, from, rel, q, opts)].map((t) => t.end.id));

      expect({ trail, ok: fast.ok, ends: fast.ends }).toEqual({
        trail,
        ok: general.ok,
        ends: general.ends,
      });
    }
  });

  test('the budget is actually reached at the small end of that sweep', () => {
    // Otherwise the test above compares two successes and proves nothing. A budget of 3 must be
    // too small for this fan at `{1,2}`.
    const g = budgeted(3);
    const from = g.getVertexById('1') as Vertex;
    const { rel, q } = relOf('-[:E]->', '{1,2}');

    expect(() => [
      ...trailEndsViaUnit(g, from, rel, q, {
        mode: 'trail',
        binding: new Map<string, unknown>(),
        params: {},
      }),
    ]).toThrow();
  });
});

describe('the restrictors actually restrict, on this fixture', () => {
  // Guards against the whole comparison above being vacuous: if every mode answered the same, the
  // sequence equality would hold for a fast path that ignored `mode` entirely. This is the check
  // item 238 had to add an edge to the fuzzer fixture to get.
  const g = build();

  const endsFor = (mode: PathMode, quant: string): string[] => {
    const { rel, q } = relOf('-[:E]->', quant);

    return [
      ...trailEnds(g, g.getVertexById('1') as Vertex, rel, q, {
        mode,
        binding: new Map<string, unknown>(),
        params: {},
      }),
    ].map((t) => t.end.id);
  };

  test('walk reaches more than trail, which reaches more than acyclic', () => {
    const walk = endsFor('walk', '{1,3}');
    const trail = endsFor('trail', '{1,3}');
    const acyclic = endsFor('acyclic', '{1,3}');

    expect(walk.length).toBeGreaterThan(trail.length);
    expect(trail.length).toBeGreaterThan(acyclic.length);
  });

  test('simple admits a return to the SEED that acyclic does not', () => {
    // `isClose` — a simple-mode walk may close back on its start, which is the one case the fast
    // path treats differently from every other hop (it emits without marking and without
    // extending).
    expect(endsFor('simple', '{1,3}')).toContain('1');
    expect(endsFor('acyclic', '{1,3}')).not.toContain('1');
  });
});
