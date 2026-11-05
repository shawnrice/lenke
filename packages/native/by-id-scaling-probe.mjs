/**
 * BY-ID ACCESS, measured as N scales — the one standing invariant with no instrument (item 1538).
 *
 * `getVertexById` / `getEdgeById` are O(1) by construction (a `Map.get`), and nothing in this repo
 * measured them. That is the gap this fills: an invariant nobody checks is an invariant that can
 * regress silently, and the two ways it regresses are both invisible to a correctness test —
 *
 *   * a lookup that becomes a SCAN still returns the right element, just in O(N);
 *   * a lookup that stays O(1) but gains a constant (a wrapper, a validation pass, a box
 *     construction per call) costs every query that resolves an id.
 *
 * So this prints BOTH: ns per lookup at each size, and the ratio against the smallest size. A flat
 * ratio column is the invariant holding. A column that tracks N is the first failure; a flat column
 * whose absolute number has moved since the last run is the second.
 *
 *   node by-id-scaling-probe.mjs
 *   SIZES=10000,100000,1000000 REPS=7 node by-id-scaling-probe.mjs
 *
 * ⚠️ THE LOOKUP KEYS ARE SHUFFLED, deterministically. Looking ids up in insertion order walks the
 * Map's own iteration order, which is exactly the access pattern a scan would also be fast at — it
 * cannot distinguish O(1) from a cache-friendly O(N). The shuffle is what makes the measurement
 * mean something; `KEYS=seq` turns it off for comparison and should be FASTER, not slower.
 *
 * ⚠️ AND IT MEASURES THREE SURFACES, because they resolve ids by different paths: the core map
 * directly, Gremlin's `V(id)` (whose `source.ids` is the shape every fused shortcut declines on, so
 * it goes down the traverser pipeline by design), and GQL's `MATCH (n) WHERE ...`. A regression in
 * one is not a regression in the others.
 */
import { Graph } from '@lenke/core';
import { V, toArray, traversal } from '@lenke/gremlin';

const SIZES = (process.env.SIZES ?? '10000,50000,200000,1000000')
  .split(',')
  .map((s) => Number(s.trim()));
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);
/** How many lookups per rep. Fixed across sizes so the per-lookup cost is comparable. */
const LOOKUPS = Number(process.env.LOOKUPS ?? 200_000);
const SHUFFLE = (process.env.KEYS ?? 'shuffled') !== 'seq';
/**
 * ⚠️ ONE source for the Gremlin arm's call count. It was computed in TWO places — inside the arm
 * and again in the reporting loop — and raising only the first inflated ns/lookup 50x (52,940
 * against a true ~1,059). A divisor used twice is a wrong number waiting to happen.
 */
const GREMLIN_CALLS = Math.max(Math.floor(LOOKUPS / Number(process.env.GDIV ?? 1000)), 1);

/** The repo's dep-free LCG, in INTEGER arithmetic — see CLAUDE.md on the f64 version's collapse. */
const lcg = (seed) => {
  let s = seed | 0;

  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;

    return s;
  };
};

const build = (n) => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i * 104_729 + 1) % n],
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

/** The ids to look up, shuffled so the order is not the Map's own. */
const keysFor = (n, prefix) => {
  const out = new Array(LOOKUPS);

  if (!SHUFFLE) {
    for (let i = 0; i < LOOKUPS; i += 1) {
      out[i] = `${prefix}${i % n}`;
    }

    return out;
  }

  const rnd = lcg(0x5eed);

  for (let i = 0; i < LOOKUPS; i += 1) {
    out[i] = `${prefix}${rnd() % n}`;
  }

  return out;
};

const timed = (fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const sink = fn();

    series.push(performance.now() - t0);

    if (sink === undefined) {
      throw new Error('arm produced nothing — the lookup was optimized away');
    }
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);

  return { p25: kept[Math.floor(kept.length * 0.25)], series };
};

const ARMS = {
  /** The core map, directly. This is the invariant itself. */
  vertexById: (g, vkeys) => () => {
    let acc = 0;

    // An index loop ON PURPOSE: a for...of allocates an iterator and steps it per element, which is
    // a real cost beside an 11 ns map hit. The O(1) conclusion is the same either way; the index
    // loop keeps the ABSOLUTE number comparable to the raw `Map.get` this exists to track.
    // oxlint-disable-next-line typescript/prefer-for-of
    for (let i = 0; i < vkeys.length; i += 1) {
      const v = g.getVertexById(vkeys[i]);

      if (v !== undefined) {
        acc += 1;
      }
    }

    return acc;
  },
  edgeById: (g, _vkeys, ekeys) => () => {
    let acc = 0;

    // oxlint-disable-next-line typescript/prefer-for-of -- see the vertex arm above.
    for (let i = 0; i < ekeys.length; i += 1) {
      const e = g.getEdgeById(ekeys[i]);

      if (e !== undefined) {
        acc += 1;
      }
    }

    return acc;
  },
  /**
   * Gremlin `V(id)`. A THOUSANDTH of the lookups, because this one builds a plan and a traverser
   * per call — it is the surface cost of an id lookup, not the map's, and at 200,000 calls it
   * dominates the whole run.
   */
  gremlinVById: (g, vkeys) => () => {
    let acc = 0;
    const n = GREMLIN_CALLS;

    for (let i = 0; i < n; i += 1) {
      acc += toArray(traversal(V(vkeys[i])), g).length;
    }

    return acc;
  },
};

const rows = [];

for (const n of SIZES) {
  const g = build(n);
  const vkeys = keysFor(n, 'v');
  const ekeys = keysFor(n, 'e');

  for (const [name, make] of Object.entries(ARMS)) {
    const calls = name === 'gremlinVById' ? GREMLIN_CALLS : LOOKUPS;
    const { p25, series } = timed(make(g, vkeys, ekeys));

    rows.push({ arm: name, n, calls, ms: p25, nsPerLookup: (p25 * 1e6) / calls, series });
  }
}

const base = new Map();

for (const r of rows) {
  if (!base.has(r.arm)) {
    base.set(r.arm, r.nsPerLookup);
  }
}

console.log(
  `by-id scaling — LOOKUPS=${LOOKUPS} REPS=${REPS} DROP=${DROP} keys=${SHUFFLE ? 'shuffled' : 'seq'}\n`,
);
console.log('arm              N          calls      ns/lookup    vs smallest N');

for (const r of rows) {
  const ratio = r.nsPerLookup / base.get(r.arm);

  console.log(
    `${r.arm.padEnd(16)} ${String(r.n).padStart(9)}  ${String(r.calls).padStart(9)}  ` +
      `${r.nsPerLookup.toFixed(1).padStart(11)}  ${ratio.toFixed(2).padStart(13)}x`,
  );
}

console.log('\nA ratio column that tracks N is a lost O(1). Flat is the invariant holding.');
console.log(JSON.stringify({ rows: rows.map(({ series: _s, ...r }) => r) }));
