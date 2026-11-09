/**
 * WHAT WOULD A CSR-BACKED LEVEL RECURRENCE BE WORTH TO THE *FILTERED* THREE-HOP COUNT?
 *
 * Item 1685 took the UNFILTERED `count 3-hop` to 7.8 ms/call with a flat-array degree product. Adding
 * any filter costs 18x-44x of that, because a filter constrains a position the product reaches only
 * as a degree, so the query falls to `sweepChain`'s per-pass walk:
 *
 *     none       7.8 ms/call
 *     interior 141.8          18.2x
 *     start    294.8          37.8x
 *     end      344.2          44.1x
 *
 * Profiled (start filter, 20 calls, 200,000 v / 1,000,000 e): `sweepOneDirection` 36.2%,
 * `bucketSize` 11.6%, `edgesOfTypes` 7.8%, `sweepChain` 6.6% — about 62% in the walk, with ~22%
 * fixture leakage and 4.4% GC.
 *
 * ⚠️ THE LEVER IS NOT THE ONE `sweepChain`'s OWN MEMO ALREADY TRIES. It carries `slotNbrs`, a flat
 * per-query memo gated `passes > 2` with item 1106's numbers (`count 4-hop` 550.5 -> 297.5, but
 * `count 3-hop + start filter` 162.0 against 165.7 — a small LOSS at two passes, because one building
 * pass is refunded by one consuming pass). A 3-leg chain with a START filter has `lastGated === false`
 * so `passes === 2`, and gets no memo at all.
 *
 * A `topologyVersion`-keyed CSR needs no amortisation on a HIT, which is what removes that gate's
 * premise rather than contradicting its measurement. This probe prices it.
 *
 * Arms, all asserted to the same count:
 *
 *   engineStart / engineEnd    the real queries, as they run today
 *   csrStart / csrEnd          the same arithmetic over flat slot runs, CSR already built
 *   csrStartPlusBuild          with the O(V+E) CSR build inside the timed region — the cold case
 *
 * ⚠️ The seed/accept SET is per-query because the predicate reads properties, so it is rebuilt in
 * every CSR arm and never cached — the same split item 1680 recorded for its projection memo.
 *
 *   node gql-filtered-chain-probe.mjs
 *   N=200000 FANOUT=5 node gql-filtered-chain-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);
const CUT = Number(process.env.CUT ?? 60);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

let e = 0;

// Nonlinear in `i` so IN-degree varies too — item 1684's third fixture trap.
for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[mix % N],
      labels: ['KNOWS'],
      properties: {},
    });
    e += 1;
  }
}

const order = [...g.verticesById.values()];

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

/** ⚠️ Per-query: the predicate reads properties, so this can never be cached on topology. */
const acceptMask = () => {
  const ok = new Uint8Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    ok[s] = Number(order[s].properties.age) > CUT ? 1 : 0;
  }

  return ok;
};

/** A START filter: seed only the accepted slots, then two passes, then a degree sum. */
const csrChainStart = ({ off, nbr }, ok) => {
  const n = order.length;
  let ways = new Float64Array(n);
  let next = new Float64Array(n);

  for (let s = 0; s < n; s += 1) {
    ways[s] = ok[s];
  }

  for (let pass = 0; pass < 2; pass += 1) {
    next.fill(0);

    for (let s = 0; s < n; s += 1) {
      const w = ways[s];

      if (w === 0) {
        continue;
      }

      const end = off[s + 1];

      for (let i = off[s]; i < end; i += 1) {
        next[nbr[i]] += w;
      }
    }

    const t = ways;
    ways = next;
    next = t;
  }

  let total = 0;

  for (let s = 0; s < n; s += 1) {
    total += ways[s] * (off[s + 1] - off[s]);
  }

  return total;
};

/** An END filter: three passes, then sum the accepted landings. */
const csrChainEnd = ({ off, nbr }, ok) => {
  const n = order.length;
  let ways = new Float64Array(n);
  let next = new Float64Array(n);

  ways.fill(1);

  for (let pass = 0; pass < 3; pass += 1) {
    next.fill(0);

    for (let s = 0; s < n; s += 1) {
      const w = ways[s];

      if (w === 0) {
        continue;
      }

      const end = off[s + 1];

      for (let i = off[s]; i < end; i += 1) {
        next[nbr[i]] += w;
      }
    }

    const t = ways;
    ways = next;
    next = t;
  }

  let total = 0;

  for (let s = 0; s < n; s += 1) {
    total += ok[s] === 1 ? ways[s] : 0;
  }

  return total;
};

const QS = `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE a.age > ${CUT} RETURN count(*) AS c`;
const QE = `MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE d.age > ${CUT} RETURN count(*) AS c`;

const MASK = acceptMask();

const ARMS = {
  engineStart: () => Number(query(g, QS)[0].c),
  csrStart: () => csrChainStart(CSR, MASK),
  csrStartPlusBuild: () => csrChainStart(buildCsr(), acceptMask()),
  engineEnd: () => Number(query(g, QE)[0].c),
  csrEnd: () => csrChainEnd(CSR, MASK),
  csrEndPlusBuild: () => csrChainEnd(buildCsr(), acceptMask()),
};

// ⚠️ START and END are DIFFERENT questions, so they are checked against their own engine arm.
const wantStart = ARMS.engineStart();
const wantEnd = ARMS.engineEnd();

for (const [name, fn] of Object.entries(ARMS)) {
  const want = name.toLowerCase().includes('end') ? wantEnd : wantStart;
  const got = fn();

  if (got !== want) {
    throw new Error(`ARM ${name} COUNTED ${got}, EXPECTED ${want} — not the same question`);
  }
}

const timed = (fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

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
  `\nFILTERED CHAIN — ${N}v / ${g.edgeCount}e, age > ${CUT}, start=${wantStart} end=${wantEnd}\n`,
);
console.log('arm                      ms    vs its engine arm');

for (const nm of names) {
  const base = nm.toLowerCase().includes('end') ? best.engineEnd : best.engineStart;

  console.log(
    `${nm.padEnd(20)} ${best[nm].toFixed(1).padStart(8)}  ${(base / best[nm]).toFixed(2).padStart(12)}x`,
  );
}
