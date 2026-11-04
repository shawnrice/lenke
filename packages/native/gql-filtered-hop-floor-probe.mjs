/**
 * HOW FAR IS `hopfiltyield` ABOVE A HAND FLOOR, and what does the floor spend its time on?
 *
 * `MATCH (a:P)-[:E]->(b:P) WHERE b.n > 5 RETURN b.n AS n` is the heaviest OPEN row in
 * `isolated-row-bench.mjs` — **~587 ns/row at random stride** — and the two obvious levers are both
 * closed:
 *
 *   item 1436  ROUTING is not it. Forcing the far-driven filtered walk measured 64.93 against
 *              60.90-64.41 at degree 1 and 123.06 against 116.87 at degree 4: no better.
 *   item 1437  THE DOUBLE READ is not it. `b.n` is read twice (predicate, projection) and nothing
 *              shares it — but same-property is 587.8 ns/row and DIFFERENT-property 545.1, so a
 *              common-subexpression pass has nothing to win.
 *
 * What was never built for this shape is a FLOOR. Item 1429 floored the UNDIRECTED hop (engine at
 * 1.45-1.51x a hand walk); the filtered directed one has no floor at all, so "587 ns/row" has never
 * been compared against what the work costs. Items 1441 and 1443 both resolved Gremlin questions this
 * way after in-file A/Bs failed — and 1443 found an apparent 3.35x that was entirely the fixture.
 *
 * ⚠️ AND THIS SHAPE HAS A COST THE GREMLIN ROWS DO NOT: it builds a ROW OBJECT per result, `{n:
 * value}`, where `values('k')` pushes a bare value. That is unpriced. The arms separate it:
 *
 *   engine         the query
 *   engine-bare    the same hop with NO predicate — the control, and the unfiltered twin
 *   floor          hand walk, predicate inline, pushes `{ n: value }`
 *   floor-noalloc  hand walk, predicate inline, pushes the bare value  -> prices the ROW OBJECT
 *   floor-nopred   hand walk, no predicate, pushes `{ n: value }`      -> prices the PREDICATE
 *   floor-bare     hand walk, no predicate, pushes the bare value      -> the walk alone
 *
 * ⚠️ DIGESTS ARE CHECKED PER GROUP. The filtered arms answer a different multiset from the unfiltered
 * ones, so a pooled check would report a false disagreement — the mistake item 1443 had to design
 * around. `group` is emitted; compare within it.
 *
 *   ARM=floor NODES=100000 STRIDE=random REPS=14 node gql-filtered-hop-floor-probe.mjs
 *
 * ONE ARM PER PROCESS (item 762).
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const ARM = process.env.ARM ?? 'engine';
const NODES = Number(process.env.NODES ?? 100_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
const FANOUT = Number(process.env.FANOUT ?? 1);
const STRIDE = process.env.STRIDE ?? 'random';

if (STRIDE !== 'small' && STRIDE !== 'random') {
  throw new Error(`STRIDE must be 'small' or 'random', got ${STRIDE}`);
}

const ARMS = [
  'engine',
  'engine-bare',
  'floor',
  'floor-noalloc',
  'floor-nopred',
  'floor-bare',
  'floor-tworead',
];

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

/** Filtered arms answer a different multiset from unfiltered ones. */
const GROUP = ['engine', 'floor', 'floor-noalloc', 'floor-tworead'].includes(ARM)
  ? 'filtered'
  : 'all';

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const i = k % NODES;
    const hop = Math.floor(k / NODES);

    g.addEdge({
      id: `e${k}`,
      from: vs[STRIDE === 'random' ? (k * 7919) % NODES : i],
      to: vs[
        STRIDE === 'random' ? (k * 104_729) % NODES : (i * 7 + 3 + hop * 2_654_435_761) % NODES
      ],
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();

/** The predicate the query carries, inline. `n` is the vertex index, so this keeps all but 6 rows. */
const KEEP = 5;

const floor = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const value = edge.to.properties['n'];

      if (value > KEEP) {
        rows.push({ n: value });
      }
    }
  }

  return rows;
};

/**
 * ⚠️ THE SAME FLOOR BUT READING `b.n` TWICE, as the engine does — which is what makes a
 * common-subexpression pass PRICEABLE (item 1444).
 *
 * Item 1437 concluded "nothing shares the read, and a CSE has nothing to win" from two ENGINE arms:
 * predicate and projection on the same property (587.8 ns/row) against different properties (545.1).
 * That pair establishes the engine does not share the read — both arms read twice — but it says
 * NOTHING about what sharing would be worth, which is a different question I ran together with it.
 * This arm against `floor` is the measurement that answers it: identical work, one read versus two.
 */
const floorTwoRead = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      // Read once for the predicate, once for the projection, through the same accessor chain.
      if (edge.to.properties['n'] > KEEP) {
        rows.push({ n: edge.to.properties['n'] });
      }
    }
  }

  return rows;
};

const floorNoAlloc = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const value = edge.to.properties['n'];

      if (value > KEEP) {
        rows.push(value);
      }
    }
  }

  return rows;
};

const floorNoPred = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      rows.push({ n: edge.to.properties['n'] });
    }
  }

  return rows;
};

const floorBare = () => {
  const rows = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      rows.push(edge.to.properties['n']);
    }
  }

  return rows;
};

const FILTERED = 'MATCH (a:P)-[:E]->(b:P) WHERE b.n > 5 RETURN b.n AS n';
const BARE = 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n';

const RUN = {
  engine: () => query(g, FILTERED),
  'engine-bare': () => query(g, BARE),
  floor,
  'floor-noalloc': floorNoAlloc,
  'floor-nopred': floorNoPred,
  'floor-bare': floorBare,
  'floor-tworead': floorTwoRead,
};

const run = RUN[ARM];

let gcMs = 0;
let gcCount = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcCount += 1;
  }
});

obs.observe({ entryTypes: ['gc'] });

const series = [];
let rowCount = 0;
/** Order-independent, and shape-independent: sums `n` whether the arm emits objects or values. */
let digest = 0;
let sink = 0;

const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = run();
    const dt = performance.now() - t0;

    series.push(dt);
    sink += rows.length;
    rowCount = rows.length;

    let d = 0;

    for (const x of rows) {
      d += typeof x === 'object' && x !== null ? Number(x['n']) : Number(x);
    }

    digest = d;
  }

  return sink;
};

await profileWindow(process.env.PROF_OUT, measure);

obs.disconnect();

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    arm: ARM,
    group: GROUP,
    nodes: NODES,
    fanout: FANOUT,
    stride: STRIDE,
    reps: REPS,
    rowCount,
    digest,
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    p75: Number(at(0.75).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    gcMs: Number(gcMs.toFixed(1)),
    gcCount,
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
