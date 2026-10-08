import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { dedupDrivesFar } from './executor/hop-projection.js';
import { query } from './index.js';

// Item 233. A START-keyed dedup over a one-hop pattern drove the start side, so the reversed
// spelling scanned the whole graph while its forward twin scanned a label bucket:
//
//   MATCH (a:Few)-[:E]->(f) RETURN DISTINCT f.t     8.9ms    dedup keyed on the FAR end
//   MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.t   115.0ms    keyed on the START
//
// 15.3x after. Item 232 fixed the same asymmetry for a plain projection by comparing two bucket
// SIZES, and that criterion cannot be reused here: a plain projection emits one row per edge, so
// both walks visit the same edges and the edge term cancels, while a START-keyed dedup BREAKS at
// the first qualifying edge, making its edge term workload-dependent. So `dedupDrivesFar` measures
// `|F| + E_F` against `|S|` instead of guessing, and abandons as soon as the running cost reaches
// `|S|` — which is what keeps the probe cheaper than the walk it is deciding against.
//
// A drive side is ANSWER-PRESERVING, so these assert the DECISION. A mutant that never switches
// sides, or always does, passes every row assertion in the package.
const lab = (name: string) => ({ kind: 'label', name }) as const;

/** The plan shape the walks and the decision share. */
const plan = (o: {
  startLabel?: ReturnType<typeof lab>;
  farLabel?: ReturnType<typeof lab>;
  onStart?: boolean;
  needsFar?: boolean;
  forward?: boolean;
}) =>
  ({
    startLabel: o.startLabel,
    farLabel: o.farLabel,
    adjacency: undefined,
    direct: { forward: o.forward ?? true, type: 'E' },
    needsFar: o.needsFar ?? true,
    onStart: o.onStart ?? true,
  }) as never;

describe('dedupDrivesFar: the decision, directly', () => {
  // 10 `:Few` each pointing at 3 of the 90 `:Many`, so the far side is narrow AND low-degree.
  const narrow = ((): Graph => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 100; i++) {
      vs.push(
        g.addVertex({ id: `v${i}`, labels: [i < 10 ? 'Few' : 'Many'], properties: { t: i } }),
      );
    }

    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 3; j++) {
        g.addEdge({
          id: `e${i}_${j}`,
          labels: ['E'],
          from: vs[i],
          to: vs[10 + i * 3 + j],
          properties: {},
        });
      }
    }

    return g;
  })();

  test('fires when the far side is narrow and its incident edges are few', () => {
    // |F| = 10, E_F = 30 (out-edges of the ten `:Few`), |S| = 100 unlabelled candidates.
    // 40 < 100, so it switches.
    expect(dedupDrivesFar(narrow, plan({ farLabel: lab('Few') }))).toBe(true);
  });

  test('REFUSES when the far side is not narrower', () => {
    expect(dedupDrivesFar(narrow, plan({ farLabel: lab('Many') }))).toBe(false);
    expect(dedupDrivesFar(narrow, plan({ farLabel: undefined }))).toBe(false);
    expect(dedupDrivesFar(narrow, plan({ startLabel: lab('Few'), farLabel: lab('Few') }))).toBe(
      false,
    );
  });

  test('REFUSES the adversarial shape: a narrow far side carrying every edge', () => {
    // THE case the bucket comparison of item 232 would get wrong. Ten `:Hub` vertices with 500
    // out-edges each (5,000 incident edges) against 1,010 start candidates: |F| + E_F = 5,010,
    // which exceeds |S|, so the start-driven walk keeps the work. Without the cost probe this
    // would switch and be several times slower.
    const hubbed = new Graph();
    const hubs = [];
    const leaves = [];

    for (let i = 0; i < 10; i++) {
      hubs.push(hubbed.addVertex({ id: `h${i}`, labels: ['Hub'], properties: { t: i } }));
    }

    for (let i = 0; i < 1000; i++) {
      leaves.push(hubbed.addVertex({ id: `l${i}`, labels: ['Leaf'], properties: { t: i % 7 } }));
    }

    for (let i = 0; i < 5000; i++) {
      hubbed.addEdge({
        id: `e${i}`,
        labels: ['E'],
        from: hubs[i % 10],
        to: leaves[i % 1000],
        properties: {},
      });
    }

    // The far bucket IS narrower — 10 against 1,010 — so the cheap precondition passes and only
    // the cost probe can refuse this. That is the whole point of having one.
    expect(dedupDrivesFar(hubbed, plan({ farLabel: lab('Hub'), forward: false }))).toBe(false);
  });

  test('REFUSES when there is nothing to win', () => {
    // `!onStart` is `walkFarSide`'s case, which is already the cheaper walk.
    expect(dedupDrivesFar(narrow, plan({ farLabel: lab('Few'), onStart: false }))).toBe(false);

    // `!needsFar` means the start-driven walk already reads ONE `bucket.size` per start and no
    // edges at all — optimal, so switching could only cost.
    expect(dedupDrivesFar(narrow, plan({ farLabel: lab('Few'), needsFar: false }))).toBe(false);
  });

  test('REFUSES a label it cannot enumerate a bucket for', () => {
    const either = { kind: 'or', left: lab('Few'), right: lab('Many') } as const;

    expect(dedupDrivesFar(narrow, plan({ farLabel: either as never }))).toBe(false);
  });
});

describe('the far-driven dedup answers what the start-driven one answers', () => {
  const build = (): Graph => {
    const g = new Graph();
    const vs = [];

    for (let i = 0; i < 60; i++) {
      vs.push(
        g.addVertex({
          id: `v${i}`,
          labels: [i < 10 ? 'Few' : 'Many'],
          properties: { k: i, t: i % 3 },
        }),
      );
    }

    // Each `:Few` points at three `:Many`, and two of them SHARE a target — so a start vertex is
    // offered to the dedup more than once, which is exactly what the far-driven walk does where
    // the start-driven one breaks after the first edge.
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 3; j++) {
        g.addEdge({
          id: `e${i}_${j}`,
          labels: ['E'],
          from: vs[i],
          to: vs[10 + ((i * 3 + j) % 20)],
          properties: {},
        });
      }
    }

    // ONE edge into a `:Few`, so a `:Many` start label has something to REJECT. Without it every
    // edge target is a `:Many`, the start label rejects nothing, and the mutant that drops that
    // check from the mirror survives — which is how it was found (audit item 233).
    g.addEdge({ id: 'eFewFew', labels: ['E'], from: vs[0], to: vs[1], properties: {} });

    return g;
  };

  /** Rows as a sorted multiset — row order without an ORDER BY is unspecified (item 198). */
  const rows = (text: string, params: Record<string, unknown> = {}): string[] =>
    query(build(), text, params)
      .map((r) => JSON.stringify(r))
      .sort();

  test('the reversed spelling matches its forward twin', () => {
    // These take DIFFERENT walks — the forward one keys the dedup on the far end — so this is a
    // cross-walk comparison of one question.
    expect(rows('MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.t AS t')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f) RETURN DISTINCT f.t AS t'),
    );
  });

  test('a start vertex reached by SEVERAL edges appears once', () => {
    // The far-driven walk offers the same start once per qualifying edge, where the start-driven
    // one breaks after the first. `take` is idempotent for a dedup, and this fixture has shared
    // targets so a non-idempotent take would duplicate rows rather than merely reorder them.
    const out = query(build(), 'MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.k AS k') as {
      k: unknown;
    }[];

    expect(out.length).toBe(new Set(out.map((r) => r.k)).size);
  });

  test('a filter on the PROJECTED end still applies', () => {
    expect(rows('MATCH (f)<-[:E]-(a:Few) WHERE f.t = 2 RETURN DISTINCT f.t AS t')).toEqual([
      JSON.stringify({ t: 2 }),
    ]);
  });

  test('ORDER BY and paging survive the switch', () => {
    const asc = query(build(), 'MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.t AS t ORDER BY t') as {
      t: unknown;
    }[];

    expect(asc.map((r) => r.t)).toEqual([0, 1, 2]);

    const paged = query(
      build(),
      'MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.t AS t ORDER BY t DESC LIMIT 2',
    ) as { t: unknown }[];

    expect(paged.map((r) => r.t)).toEqual([2, 1]);
  });

  test('the counting twin agrees with the row form', () => {
    const counted = query(build(), 'MATCH (f)<-[:E]-(a:Few) RETURN count(DISTINCT f.t) AS c') as {
      c: unknown;
    }[];

    expect(counted).toEqual([{ c: 3 }]);
  });

  test('a LABEL on the projected end is applied to the resolved endpoint', () => {
    // Driving the far side means the START label is no longer implicit in the enumeration, so it
    // has to be tested on the RESOLVED endpoint. This is the case that distinguishes: `:Many` on
    // `f` must exclude the one `:Few` target, and the far side (`:Few`, 10) is narrower than the
    // start side (`:Many`, 50) so the mirror actually fires. With every target a `:Many` the
    // label rejects nothing and the mutant that drops the check survives.
    const projected = query(build(), 'MATCH (f:Many)<-[:E]-(a:Few) RETURN DISTINCT f.k AS k') as {
      k: unknown;
    }[];

    expect(projected.every((r) => (r.k as number) >= 10)).toBe(true);
    expect(rows('MATCH (f:Many)<-[:E]-(a:Few) RETURN DISTINCT f.k AS k')).toEqual(
      rows('MATCH (a:Few)-[:E]->(f:Many) RETURN DISTINCT f.k AS k'),
    );

    // And UNLABELLED, where that one `:Few` target must now appear — so the pair shows the label
    // is doing work rather than being vacuous.
    const all = query(build(), 'MATCH (f)<-[:E]-(a:Few) RETURN DISTINCT f.k AS k') as {
      k: unknown;
    }[];

    expect(all.some((r) => (r.k as number) < 10)).toBe(true);
  });

  test('both arrow directions, so the mirrored index is not inverted', () => {
    expect(rows('MATCH (f)-[:E]->(a:Many) RETURN DISTINCT f.t AS t')).toEqual(
      rows('MATCH (a:Many)<-[:E]-(f) RETURN DISTINCT f.t AS t'),
    );
  });
});
