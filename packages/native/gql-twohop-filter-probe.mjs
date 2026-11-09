/**
 * WHAT WOULD A 2-LEG CSR LEVEL RECURRENCE BE WORTH TO THE *FILTERED* TWO-HOP COUNTS?
 *
 * The three-hop family is taken: items 1685 (unfiltered, 81.4x), 1688 (start/end filters, 33.9x and
 * 28.8x) and 1689 (interior filter, 14.8x). The two-hop family was left, and it has TWO routes
 * rather than one:
 *
 *   - START filter -> `buildFilteredTwoHopCount`, which drives from the start, gates each `a` once,
 *     then expands twice and reads a DEGREE per middle edge through a string-keyed lookup. That
 *     degree read is the same |E| hash lookups items 1685 and 1689 replaced with an index.
 *   - END filter -> the GENERAL ROW PIPELINE. `buildTwoHopCount`'s own comment says a constraint on
 *     the end "has no once-per-element place to go, because the product reaches it only as a
 *     degree". A level recurrence gives it one.
 *
 * ⚠️ ONE LEVER HERE IS ALREADY REFUTED AND THIS IS NOT IT. Item 1517 built the "end formula" — the
 * reversed walk — and measured it 2.0x WORSE (265.5 ms against 132.4), because it is selectivity-
 * blind and structurally so. This prices a different operation: not a cheaper route to the same
 * degree lookup, but an INDEX in place of the lookup.
 *
 *   node gql-twohop-filter-probe.mjs
 *   N=200000 FANOUT=5 node gql-twohop-filter-probe.mjs
 *
 * ⚠️ Target NONLINEAR in `i`, so in-degree varies: a linear `(a*i+b) % N` is a bijection per layer
 * and makes a k-walk count `N * F^k` by arithmetic however the traversal behaves (item 1684).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const CUT = Number(process.env.CUT ?? 60);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

let e = 0;
const targets = new Set();

for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    targets.add(mix % N);
    g.addEdge({ id: `e${e}`, from: vs[i], to: vs[mix % N], labels: ['KNOWS'], properties: {} });
    e += 1;
  }
}

if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const order = [...g.verticesById.values()];

/** The CSR the engine already caches on `topologyVersion`; built here so the arm can be timed. */
const buildCsr = () => {
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(g.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const edge of order[i].adjFrom?.get('KNOWS') ?? []) {
      nbr[at] = idx.get(edge.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { off, nbr };
};

const CSR = buildCsr();

/** ⚠️ Per-query: the predicate reads PROPERTIES, which deliberately do not bump topologyVersion. */
const acceptMask = () => {
  const ok = new Uint8Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    ok[s] = Number(order[s].properties.age) > CUT ? 1 : 0;
  }

  return ok;
};

/** START filter: seed only accepted slots, one pass, then a degree sum. */
const csrStart = ({ off, nbr }, ok) => {
  const n = order.length;
  const next = new Float64Array(n);

  for (let s = 0; s < n; s += 1) {
    if (ok[s] === 0) {
      continue;
    }

    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      next[nbr[i]] += 1;
    }
  }

  let total = 0;

  for (let s = 0; s < n; s += 1) {
    total += next[s] * (off[s + 1] - off[s]);
  }

  return total;
};

/** END filter: every slot live, one pass, then sum the ACCEPTED landings' arrivals. */
const csrEnd = ({ off, nbr }, ok) => {
  const n = order.length;
  const mid = new Float64Array(n);

  for (let s = 0; s < n; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      mid[nbr[i]] += 1;
    }
  }

  let total = 0;

  for (let s = 0; s < n; s += 1) {
    const w = mid[s];

    if (w === 0) {
      continue;
    }

    let accepted = 0;
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      accepted += ok[nbr[i]];
    }

    total += w * accepted;
  }

  return total;
};

const QS = `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE a.age > ${CUT} RETURN count(*) AS c`;
const QE = `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE c.age > ${CUT} RETURN count(*) AS c`;
const MASK = acceptMask();

const ARMS = {
  engineStart: () => Number(query(g, QS)[0].c),
  csrStart: () => csrStart(CSR, MASK),
  csrStartPlusBuild: () => csrStart(buildCsr(), acceptMask()),
  engineEnd: () => Number(query(g, QE)[0].c),
  csrEnd: () => csrEnd(CSR, MASK),
  csrEndPlusBuild: () => csrEnd(buildCsr(), acceptMask()),
};

// ⚠️ START and END are DIFFERENT questions, each checked against its OWN engine arm.
const wantStart = ARMS.engineStart();
const wantEnd = ARMS.engineEnd();

for (const [name, fn] of Object.entries(ARMS)) {
  const want = name.toLowerCase().includes('end') ? wantEnd : wantStart;
  const got = fn();

  if (got !== want) {
    throw new Error(`ARM ${name} COUNTED ${got}, EXPECTED ${want} — not the same question`);
  }
}

/** ⚠️ MEDIAN of the warm reps, not min: the TS per-row path plateaus and emits a rare fast rep. */
const timed = (fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const warm = series.slice(3).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const names = Object.keys(ARMS);
const best = {};

for (let round = 0; round < 3; round += 1) {
  for (const nm of round % 2 === 0 ? names : [...names].reverse()) {
    best[nm] = Math.min(best[nm] ?? Infinity, timed(ARMS[nm]));
  }
}

console.log(
  `\nTWO-HOP FILTERED — ${N}v / ${g.edgeCount}e, ${targets.size} distinct endpoints, age > ${CUT}`,
);
console.log(`start=${wantStart} end=${wantEnd}\n`);
console.log('arm                      ms    vs its engine arm');

for (const nm of names) {
  const base = nm.toLowerCase().includes('end') ? best.engineEnd : best.engineStart;

  console.log(
    `${nm.padEnd(20)} ${best[nm].toFixed(1).padStart(8)}  ${(base / best[nm]).toFixed(2).padStart(12)}x`,
  );
}
