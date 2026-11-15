// THE TWO-HOP COUNT against a hand walk, at a fixture ABOVE the dense admission threshold
// (item 1982).
//
// ⚠️⚠️ **THIS FILE EXISTS BECAUSE THE SUITE'S FIXTURES CANNOT REACH THE DENSE ARM AT ALL.**
// `denseChainCount` admits only when `seeds.length > max(vertexCount >> 4, 1024)`, so on any graph
// below 1,024 vertices it is unreachable BY ARITHMETIC — and every other fixture in this package is
// far below that. Item 1978 found the same shape of hole one package over: a parity suite passing
// 801 assertions while never entering the route it named.
//
// 🔭 **THE ROUTE IT ANTICIPATES IS NOT BUILT.** Items 1859-1861 priced the dense slot route for this
// shape at 3.97x and declined it on item 1695's criterion (the two-hop walk is 52 ms against a
// 160 ms rebuild, so the build can be wasted). Item 1982 re-opened that — item 1889's second-ask
// policy removes the waste — but located the target on a DIFFERENT arm than first assumed, so the
// build is deferred. What ships here is the coverage that arm will need: three hop directions and a
// topology write, each against a hand walk over the adjacency, on a fixture the dense gate admits.
//
// ⚠️ The three direction cases are NOT decoration. An unfiltered two-hop count is answered by a
// DEGREE INNER PRODUCT (`sum over w of arrivals(w) * departures(w)`, item 590), and `both.out` and
// `out.both` come out different because a `both` hop's two factors coincide — so a route change that
// got direction wrong would be visible only here.
//
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { count, hasLabel, in_, out, toArray, traversal, V } from '../index.js';

/**
 * ⚠️ 2,000 VERTICES, NOT A HANDFUL. `max(2000 >> 4, 1024)` is 1024, so a full-graph frontier of
 * 2,000 clears it; at 1,024 or fewer the dense arm cannot fire at all and this file would assert
 * nothing. The number is checked in the first test rather than trusted.
 */
const NODES = 2000;
const FANOUT = 3;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${String(i)}`, labels: ['P'], properties: { k: i % 97 } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    // Split on the REPEAT INDEX — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy, without which
    // one vertex's FANOUT edges all land on the SAME target and a two-hop count is `F^2` by
    // construction, which would agree between the two routes for the wrong reason.
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(`v${String(i)}`)!,
      to: g.getVertexById(`v${String((i * 7 + 3 + hop * 2_654_435_761) % NODES)}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** The two-hop count by hand, over the adjacency rather than either engine route. */
const byHand = (g: Graph): number => {
  let total = 0;

  for (const v of g.vertices) {
    const box0 = v.adjFrom?.get('E');

    if (box0 === undefined) {
      continue;
    }

    for (const e of box0) {
      total += e.to.adjFrom?.get('E')?.size ?? 0;
    }
  }

  return total;
};

const twoHop = (g: Graph): number =>
  toArray(traversal(V(), hasLabel('P'), out('E'), out('E'), count()), g)[0] as number;

describe('the two-hop count agrees with a hand walk above the dense threshold', () => {
  test('the fixture is large enough for the dense gate to ADMIT it', () => {
    const g = build();

    // The exact admission arithmetic from `denseChainCount`. A full-graph frontier is the seed set
    // for `V().hasLabel('P').out('E').out('E')`, so this is the real comparison, not a proxy.
    expect(g.vertexCount).toBe(NODES);
    expect(NODES).toBeGreaterThan(Math.max(g.vertexCount >> 4, 1024));
  });

  test('repeated asks agree with each other and with a hand walk', () => {
    const g = build();
    const want = byHand(g);

    // Asked three times: any route that switches arms on a repeat ask — which is what item 1889's
    // second-ask policy does elsewhere in this executor — must not change the answer when it does.
    expect(twoHop(g)).toBe(want);
    expect(twoHop(g)).toBe(want);
    expect(twoHop(g)).toBe(want);
  });

  test('a TOPOLOGY WRITE does not change the answer either side of it', () => {
    const g = build();

    expect(twoHop(g)).toBe(byHand(g));
    expect(twoHop(g)).toBe(byHand(g));

    // Any cache in this family is keyed on `graph.topologyVersion`, so an added edge drops the
    // generation and the next ask starts over. That is the property that makes a write-every-read
    // workload never pay a build — and it must not change the answer either.
    g.addEdge({
      id: 'extra',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v1')!,
      labels: ['E'],
      properties: {},
    });

    const after = byHand(g);

    expect(twoHop(g)).toBe(after);
    expect(twoHop(g)).toBe(after);
  });

  test('an INWARD two-hop count agrees across both asks and with a hand walk', () => {
    // A route that picks a CSR direction from `hops[0].kind` must reach the MIRROR entry for an
    // inward chain rather than the forward one — a gate that ignored direction would count the
    // wrong walks here and nowhere else.
    const g = build();
    let want = 0;

    for (const v of g.vertices) {
      for (const e of v.adjTo?.get('E') ?? []) {
        want += e.from.adjTo?.get('E')?.size ?? 0;
      }
    }

    const inward = (): number =>
      toArray(traversal(V(), hasLabel('P'), in_('E'), in_('E'), count()), g)[0] as number;

    expect(inward()).toBe(want);
    expect(inward()).toBe(want);
  });

  test('a MIXED-direction chain is correct and stable across asks', () => {
    // `oneWalkThroughout` is false for `out` then `in`, so no same-index route may fire. Asked
    // twice, because a gate that dropped that condition would switch arms on the second ask and
    // count a forward chain.
    const g = build();
    let want = 0;

    for (const v of g.vertices) {
      for (const e of v.adjFrom?.get('E') ?? []) {
        want += e.to.adjTo?.get('E')?.size ?? 0;
      }
    }

    const mixed = (): number =>
      toArray(traversal(V(), hasLabel('P'), out('E'), in_('E'), count()), g)[0] as number;

    expect(mixed()).toBe(want);
    expect(mixed()).toBe(want);
  });
});
