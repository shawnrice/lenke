/*
 * Item 2093 — AFTER ONE WRITE, HOW MANY LATER READS ARE SLOW? One, or all of them?
 *
 * The native engine's behaviour is documented and severe: "`rebuild_csr` runs only at LOAD, and
 * every adjacency write clears `csr_fresh` with nothing to re-arm it, so ONE `add_edge` demotes EVERY
 * later read for the rest of the session." The TS GQL engine has its OWN `csr-cache.ts`, keyed on
 * `graph.topologyVersion`, which "drops a single stale generation WHOLE rather than per shape" — the
 * same shape — but it also has `csrAskedBefore`, a SECOND-ASK arming so a one-shot query never pays
 * for a build. Whether those two combine into "one slow read" or "every read slow" is the question.
 *
 * THE PER-READ SERIES IS THE INSTRUMENT, NOT A SUMMARY. A min- or median-of-N hides a second-ask
 * arming completely: the arming shows up as a STEP in the series, and one slow read among twenty is
 * invisible to any estimator. [[floor-arm-must-take-same-route]] records that exact trap.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 60000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const READS = Number(process.env.READS ?? 10);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, k: i % 50 } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
      labels: ['E'],
      properties: { w: i % 7 },
    });
  }

  return g;
};

/* A two-hop count: the shape item 2087 showed is answered off the CSR, so it is the one a dropped
 * generation should be visible in. */
const READ = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c';

const timeRead = (g) => {
  const t0 = performance.now();
  const rows = query(g, READ);

  return { ms: performance.now() - t0, answer: rows[0].c };
};

const g = build();
const series = [];
const answers = new Set();

// Warm: let the cache arm and settle before anything is attributed to a write.
for (let i = 0; i < READS; i += 1) {
  const { ms, answer } = timeRead(g);

  series.push({ phase: 'warm', ms });
  answers.add(answer);
}

/*
 * THE WRITE IS ONE EDGE, and it is a TOPOLOGY write on purpose: a property-only write does not
 * bump `topologyVersion`, so it would answer a different (easier) question and read as "no effect".
 */
let writeMs = 0;

{
  const t0 = performance.now();

  g.addEdge({
    id: 'eNEW',
    from: g.getVertexById('v0'),
    to: g.getVertexById('v1'),
    labels: ['E'],
    properties: { w: 0 },
  });
  writeMs = performance.now() - t0;
}

for (let i = 0; i < READS; i += 1) {
  const { ms, answer } = timeRead(g);

  series.push({ phase: 'after', ms });
  answers.add(answer);
}

// A second write, to see whether the pattern repeats or the cache stays armed.
g.addEdge({
  id: 'eNEW2',
  from: g.getVertexById('v2'),
  to: g.getVertexById('v3'),
  labels: ['E'],
  properties: { w: 0 },
});

for (let i = 0; i < READS; i += 1) {
  const { ms } = timeRead(g);

  series.push({ phase: 'after2', ms });
}

/*
 * THE WORKLOAD QUESTION, which the phases above do not answer. Two demoted reads per write is
 * cheap if writes are rare and ruinous if every read follows one. These two arms do the SAME NUMBER
 * of reads; only the write placement differs.
 */
const CYCLES = Number(process.env.CYCLES ?? 12);

const interleaved = () => {
  const h = build();
  let sink = 0;

  // Warm it once so the first cycle is not paying the initial build.
  timeRead(h);
  timeRead(h);

  const t0 = performance.now();

  for (let c = 0; c < CYCLES; c += 1) {
    h.addEdge({
      id: `iw${c}`,
      from: h.getVertexById(`v${c}`),
      to: h.getVertexById(`v${c + 1}`),
      labels: ['E'],
      properties: { w: 0 },
    });
    sink += timeRead(h).answer;
  }

  return { ms: performance.now() - t0, sink };
};

const batched = () => {
  const h = build();
  let sink = 0;

  timeRead(h);
  timeRead(h);

  const t0 = performance.now();

  // EVERY WRITE FIRST, then every read — the same writes and the same read COUNT, so the only
  // difference is how many times the topology version moves between reads.
  for (let c = 0; c < CYCLES; c += 1) {
    h.addEdge({
      id: `bw${c}`,
      from: h.getVertexById(`v${c}`),
      to: h.getVertexById(`v${c + 1}`),
      labels: ['E'],
      properties: { w: 0 },
    });
  }

  for (let c = 0; c < CYCLES; c += 1) {
    sink += timeRead(h).answer;
  }

  return { ms: performance.now() - t0, sink };
};

/*
 * THE MECHANISM TEST, and it is what separates "writes are expensive" from "the ARMING declines
 * to build for a single reader". `csrAskedBefore` builds on the SECOND ask of a topology version, so a
 * workload reading ONCE per write never builds at all and pays the non-CSR path every time. Reading
 * TWICE per write should recover the cached speed on the second read — if it does, the arming is the
 * whole explanation and the heuristic is behaving exactly as designed.
 */
const interleavedTwice = () => {
  const h = build();
  let sink = 0;

  timeRead(h);
  timeRead(h);

  const t0 = performance.now();

  for (let c = 0; c < CYCLES; c += 1) {
    h.addEdge({
      id: `tw${c}`,
      from: h.getVertexById(`v${c}`),
      to: h.getVertexById(`v${c + 1}`),
      labels: ['E'],
      properties: { w: 0 },
    });
    sink += timeRead(h).answer;
    sink += timeRead(h).answer;
  }

  return { ms: performance.now() - t0, sink };
};

const iv = interleaved();
const bt = batched();

console.log(
  `\n  ${CYCLES} writes + ${CYCLES} reads, same counts both ways:\n` +
    `    interleaved (write, read, write, read, …): ${iv.ms.toFixed(1)} ms\n` +
    `    batched     (all writes, then all reads): ${bt.ms.toFixed(1)} ms\n` +
    `    interleaving costs ${(iv.ms / bt.ms).toFixed(2)}x`,
);

const i2 = interleavedTwice();

console.log(
  `    interleaved but TWO reads per write: ${i2.ms.toFixed(1)} ms for ${CYCLES * 2} reads ` +
    `= ${(i2.ms / (CYCLES * 2)).toFixed(2)} ms/read, against one-read's ` +
    `${(iv.ms / CYCLES).toFixed(2)} and batched's ${(bt.ms / CYCLES).toFixed(2)}`,
);

const show = (phase) =>
  series
    .filter((s) => s.phase === phase)
    .map((s) => s.ms.toFixed(1))
    .join(' ');

const medianOf = (phase) => {
  const xs = series
    .filter((s) => s.phase === phase)
    .map((s) => s.ms)
    .sort((a, b) => a - b);

  return xs[Math.floor(xs.length / 2)];
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, ${READS} reads per phase\n`);
console.log(`  warm  : ${show('warm')}`);
console.log(`  +1 edge: ${show('after')}`);
console.log(`  +2 edge: ${show('after2')}`);
console.log(`\n  the single write itself: ${writeMs.toFixed(2)} ms`);
console.log(
  `  medians  warm ${medianOf('warm').toFixed(1)}  after ${medianOf('after').toFixed(1)}  ` +
    `after2 ${medianOf('after2').toFixed(1)}`,
);

/*
 * THE ANSWER MUST MOVE EXACTLY ONCE PER WRITE, and the set is how that is checked: the two-hop
 * count changes when an edge is added, so a run where every answer is identical would mean the reads
 * are not seeing the write at all — and would make every timing above meaningless.
 */
console.log(
  `  distinct answers seen: ${answers.size} (expected 2 — before and after the first write)`,
);

if (answers.size < 2) {
  throw new Error('the reads did not observe the write — the timings say nothing');
}
