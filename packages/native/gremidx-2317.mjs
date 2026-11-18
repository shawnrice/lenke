/**
 * ⚠️⚠️ **DOES GREMLIN USE THE PROPERTY INDEX? (item 2317)**
 *
 * Item 2316 profiled the INDEXED GQL workload and found it flat — the index does its job and no frame
 * exceeds 10%. 🔑 **Gremlin has had no equivalent pass**, and the question that matters most is not how its
 * frames are distributed but whether `has('name', x)` SEEKS or SCANS.
 *
 * ⚠️ The repo's standing rule is that equivalent spellings must cost the same. These two are equivalent
 * ACROSS LANGUAGES — `MATCH (u:User) WHERE u.name = $n` and `V(), hasLabel('User'), has('name', n)` — and
 * both lower to the same storage. ✅ If one seeks and the other scans, that is a real defect and it scales
 * with |V|, so the sweep over USERS is the diagnostic: **a seek is FLAT, a scan is LINEAR.**
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, has, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const USERS = Number(process.env.USERS ?? 50_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 25);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const INDEX = process.env.INDEX !== '0';
const MIXED = process.env.MIXED === '1';
const ARM = process.env.ARM ?? 'gremHas';

const graph = new Graph();
const TEAMS = ['core', 'platform', 'data', 'infra'];

for (let i = 0; i < USERS; i += 1) {
  graph.addVertex({
    id: `u${i}`,
    /*
     * ⚠⚠ **MIXED=1 IS THE REALISTIC MODE** (`label-vacuity-gates-fast-paths`). With every vertex
     * `:User` the label is VACUOUS, so `dropVacuousLabels` drops the step and REBUILDS the plan every
     * call — discarding the flags `Plan` carries by construction. A real schema has several labels, the
     * label is selective, nothing is dropped, and the rebuild should not happen.
     */
    labels: MIXED && i % 3 !== 0 ? ['Other'] : ['User'],
    properties: { name: `user${i}`, team: TEAMS[i % 4], score: i % 100 },
  });
}

if (INDEX) {
  graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

/*
 * ⚠⚠ **THE TARGET MUST BE `:User` IN BOTH MODES, OR THE ARMS MEASURE DIFFERENT THINGS.** The first
 * version picked `USERS / 2`, which under `MIXED=1` is `:Other` — so the arm returned rows=0 and timed a
 * MISS against the other mode's HIT. Divisible by 3 keeps it `:User` either way; the row count printed
 * below is what caught it.
 */
const TARGET = 3 * ((USERS / 6) | 0);
const NAME = `user${TARGET}`;
const NAME_ID = `u${TARGET}`;

/* ✅ Plans built ONCE, which is the hoisted form the guide prescribes — so this measures the WALK. */
const pHas = traversal(V(), hasLabel('User'), has('name', NAME), values('score'));
const pScan = traversal(V(), hasLabel('User'), has('team', 'nosuchteam'), values('score'));
const pById = traversal(V(NAME_ID), values('score'));

/*
 * ✅✅ **THE ABLATION LADDER (item 2318), ONE ARM PER PROCESS.** Item 2317 left 5.8x between `V(id)`
 * (0.21 µs) and the full `V(), hasLabel, has, values` (1.28 µs), both flat in |V|. 🔑 These rungs add one
 * element at a time so the 1.06 µs can be attributed rather than guessed.
 *
 * ⚠️ **A LADDER IN ONE PROCESS IS THE SHAPE ITEM 2285 SHOWED FLATTERS ITSELF** — each arm pollutes the
 * next one's dispatch. Selected by `ARM`, so each runs alone.
 */
/*
 * ✅ **THE WHOLE-SCAN SHAPES (item 2320).** Item 2319 shipped 2.83x by replacing ONE `drain: () =>
 * [...walk()]`, over a seeded bucket of one. 🔑 Eight siblings remain, and they walk WHOLE LABELS — so the
 * per-element generator protocol multiplies by |V| even if the ratio is smaller. These arms are the
 * commonest Gremlin read, and they are the PRE side of that A/B.
 */
const pScanVals = traversal(V(), hasLabel('User'), values('score'));
const pScanValsNoLabel = traversal(V(), values('score'));

const pIdVals = traversal(V(NAME_ID), values('score'));
const pSeedLabel = traversal(V(), hasLabel('User'));
const pSeedLabelHas = traversal(V(), hasLabel('User'), has('name', NAME));
const pHasNoLabel = traversal(V(), has('name', NAME));
const pHasNoLabelVals = traversal(V(), has('name', NAME), values('score'));

const ARMS = {
  /* ✅ The GQL spelling, which item 2316 showed seeks. */
  gqlSeek: () =>
    query(graph, 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s', { n: NAME }).length,
  /* ⚠️ THE QUESTION: does the Gremlin twin seek, or scan all of |V|? */
  gremHas: () => toArray(pHas, graph).length,
  /* ✅ A control that CANNOT seek — no index on `team` — so it bounds what a scan costs here. */
  gremScan: () => toArray(pScan, graph).length,
  /* ✅ The by-id path, which must stay O(1) whatever the index does. */
  gremById: () => toArray(pById, graph).length,
  /* ✅ LADDER: by-id plus the projection, isolating what `values()` costs. */
  gremIdVals: () => toArray(pIdVals, graph).length,
  /* ⚠️ LADDER: the whole-V seed plus a label, with NO seek — this one is linear by construction. */
  gremSeedLabel: () => toArray(pSeedLabel, graph).length,
  /* ✅ LADDER: seed + label + seek, no projection. */
  gremSeedLabelHas: () => toArray(pSeedLabelHas, graph).length,
  /* 🔑 LADDER: the seek WITHOUT the label — if this is fast, `hasLabel` is the cost. */
  gremHasNoLabel: () => toArray(pHasNoLabel, graph).length,
  /* 🔑 LADDER: seek + projection, no label. */
  gremHasNoLabelVals: () => toArray(pHasNoLabelVals, graph).length,
  /* ✅ WHOLE-SCAN: the commonest Gremlin read, and where a per-element cost multiplies by |V|. */
  gremScanVals: () => toArray(pScanVals, graph).length,
  /* ✅ WHOLE-SCAN without the label, which routes to a different shortcut. */
  gremScanValsNoLabel: () => toArray(pScanValsNoLabel, graph).length,
};

const arm = ARMS[ARM];

for (let w = 0; w < 300; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 200_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `  USERS=${String(USERS).padStart(7)} INDEX=${INDEX ? 1 : 0} MIXED=${MIXED ? 1 : 0} ARM=${ARM.padEnd(9)} ${(med * 1000).toFixed(2).padStart(10)} us   rows=${arm()}`,
);
