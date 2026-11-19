// What an INLINE constraint at one position of a long chain costs, in both engines.
//
// Written to price item 303 and kept as its regression guard. Before that item the TS sweep
// refused any constrained node (`plainNode`), so one gated interior position declined every
// shortcut in the family and fell to the general matcher — 25-82x the unconstrained chain. The
// sweep VISITS every position, so a gate has a once-per-element place to go (item 219's argument,
// one family along), and the TS column now reads 1.2-1.7x.
//
// Item 304 closed the native half the same way (28-121x -> 1.7-2.0x), so both columns now price
// the FOLLOW-UPS instead: the three-spellings table below is what keeps an inline constraint, a
// clause `WHERE` and a per-position LABEL honest against each other, in both engines. A spelling
// that costs more than its twins is the bug class this repo has found four times (item 125).
//
// Each case is paired with the UNCONSTRAINED chain it routes beside, because the question is not
// "how long does the filtered count take" but "what does DECLINING cost" — and the honest control
// for a defeated shortcut is the same shape WITHOUT the filter, which item 290's rejected E68/E69
// note makes explicit.
//
// Run: cd packages/native && bun run bench:gate
import { Graph, type Vertex } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const NODES = Number(process.env.GATE_N ?? 20_000);
const DEG = Number(process.env.GATE_DEG ?? 3);
/*
 * NINE reps, not three, and a MEDIAN of the post-warmup ones rather than a min.
 *
 * ⚠️ At this bench's default fixture its rows are 0.7-3.0 ms and two runs of the SAME build disagree by
 * 2.1-2.5x: item 2365 measured `position 3` at 1.1 then 2.7, `position 4` at 3.0 then 1.4, and the
 * three-spellings table at inline 1.0 / clause 1.5 in one run and 1.4 / 1.4 in the next. **So the single
 * min-of-3 figure this bench used to print could not resolve anything under ~2.5x**, and a reader (me)
 * nearly published a 1.5x spelling gap and a 3.4x position regression from one run of it.
 *
 * `min` is also the wrong estimator for the TS path specifically — `ts-spelling-probe` records the general
 * scalar path plateauing high and emitting a RARE fast rep, so `min` reports the outlier while a
 * specialized closure is flat. Median after dropping warm-up is what that probe settled on.
 *
 * The series is printed for the same reason: a spread is visible where a single number is not.
 */
const REPS = Number(process.env.GATE_REPS ?? 9);
/** Reps dropped before the median — the JIT is visibly still tiering up across the first few. */
const WARMUP = Math.min(3, REPS - 1);

const lines: string[] = [];

for (let i = 0; i < NODES; i++) {
  lines.push(
    JSON.stringify({
      type: 'vertex',
      id: `v${i}`,
      labels: i % 2 === 0 ? ['N', 'H'] : ['N'],
      properties: { k: i % 4, i },
    }),
  );
}

for (let i = 0; i < NODES; i++) {
  for (let d = 0; d < DEG; d++) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${i}_${d}`,
        from: `v${i}`,
        to: `v${(i * 7 + d * 31 + 1) % NODES}`,
        labels: ['E'],
        properties: {},
      }),
    );
  }
}

const tsGraph = new Graph();
const ids: Vertex[] = [];

for (let i = 0; i < NODES; i++) {
  ids.push(
    tsGraph.addVertex({ labels: i % 2 === 0 ? ['N', 'H'] : ['N'], properties: { k: i % 4, i } }),
  );
}

for (let i = 0; i < NODES; i++) {
  for (let d = 0; d < DEG; d++) {
    tsGraph.addEdge({
      from: ids[i],
      to: ids[(i * 7 + d * 31 + 1) % NODES],
      labels: ['E'],
      properties: {},
    });
  }
}

const nat = graphFromNdjson(nativeBackend(), `${lines.join('\n')}\n`);

/** A 5-hop chain; `at` is the interior position (1..4) that carries `{k: 1}`, or -1 for none. */
const chain = (at: number): string => {
  let q = 'MATCH (a:N)';

  for (let h = 0; h < 5; h++) {
    const name = `n${h}`;

    q += `-[:E]->(${name}${h === at ? ' {k: 1}' : ''})`;
  }

  return `${q} RETURN count(*) AS c`;
};

const timed = (run: () => number): { ms: number; answer: number; series: number[] } => {
  const series: number[] = [];
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const a = run();

    series.push(performance.now() - t0);
    answer = a;
  }

  const kept = series.slice(WARMUP).sort((a, b) => a - b);
  const ms = kept[Math.floor(kept.length / 2)] ?? series[0] ?? 0;

  return { ms, answer, series };
};

/** The per-rep spread, so an unresolvable row is visible as one. */
const spread = (series: number[]): string => {
  const kept = series.slice(WARMUP);
  const lo = Math.min(...kept);
  const hi = Math.max(...kept);

  return `${(hi / Math.max(lo, 1e-9)).toFixed(1)}x`.padStart(8);
};

/** How many times the gated chain costs what the unconstrained one does. */
const ratio = (ms: number, free: number): string => `${(ms / free).toFixed(1)}x`.padStart(11);

console.log(
  `${NODES} vertices / ${NODES * DEG} edges, 5 hops, median of ${REPS - WARMUP} after ${WARMUP} warm-up` +
    ` (knobs: GATE_N, GATE_DEG, GATE_REPS)`,
);
console.log(
  '  NOTE: at the default fixture these rows are single-digit ms and spread 2.1-2.5x between identical' +
    ' runs (item 2365). Read the spread column before believing any ratio; raise GATE_N to resolve one.',
);
console.log(
  'constrained at      ts ms    vs free  ts spread      native ms    vs free      answer   agree',
);

const freeTs = timed(() => ([...tsQuery(tsGraph, chain(-1))] as { c: number }[])[0]?.c ?? -1);
const freeNat = timed(() => {
  const rows = nat.query(chain(-1)) as { c: number }[];

  return rows[0]?.c ?? -1;
});

console.log(
  `${'(none)'.padEnd(20)}${freeTs.ms.toFixed(1).padStart(7)}${'-'.padStart(11)}` +
    `${freeNat.ms.toFixed(1).padStart(14)}${'-'.padStart(11)}` +
    `${String(freeTs.answer).padStart(12)}   ${freeTs.answer === freeNat.answer ? 'yes' : 'NO'}`,
);

for (let at = 0; at < 5; at++) {
  const q = chain(at);
  const ts = timed(() => ([...tsQuery(tsGraph, q)] as { c: number }[])[0]?.c ?? -1);
  const nt = timed(() => {
    const rows = nat.query(q) as { c: number }[];

    return rows[0]?.c ?? -1;
  });

  const label = at === 4 ? 'position 4 (last)' : `position ${at}`;

  console.log(
    `${label.padEnd(20)}${ts.ms.toFixed(1).padStart(7)}${ratio(ts.ms, freeTs.ms)}${spread(ts.series)}` +
      `${nt.ms.toFixed(1).padStart(14)}${ratio(nt.ms, freeNat.ms)}` +
      `${String(ts.answer).padStart(12)}   ${ts.answer === nt.answer ? 'yes' : `NO (${nt.answer})`}`,
  );
}

// The SAME question in three spellings, at an interior position. They must agree on the answer
// and cost the same: the gate's position comes from its predicate's SLOT, not from where the
// optimizer put the `Filter`, and an inline `{k: 1}` is pushed down to the hop that binds the node
// while a clause `WHERE` is not.
console.log('');
console.log(
  'one position, three spellings      ts ms  ts spread      native ms      answer   agree',
);

const spellings: [string, string][] = [
  [
    'inline {k: 1} at 2',
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2 {k: 1})-[:E]->(n3)-[:E]->(n4) RETURN count(*) AS c',
  ],
  [
    'clause WHERE n2.k = 1',
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)-[:E]->(n3)-[:E]->(n4) WHERE n2.k = 1 RETURN count(*) AS c',
  ],
  [
    'flipped 1 = n2.k',
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)-[:E]->(n3)-[:E]->(n4) WHERE 1 = n2.k RETURN count(*) AS c',
  ],
  [
    'label (n2:H) at 2',
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2:H)-[:E]->(n3)-[:E]->(n4) RETURN count(*) AS c',
  ],
];

for (const [label, q] of spellings) {
  const ts = timed(() => ([...tsQuery(tsGraph, q)] as { c: number }[])[0]?.c ?? -1);
  const nt = timed(() => {
    const rows = nat.query(q) as { c: number }[];

    return rows[0]?.c ?? -1;
  });

  console.log(
    `${label.padEnd(30)}${ts.ms.toFixed(1).padStart(7)}${spread(ts.series)}${nt.ms.toFixed(1).padStart(15)}` +
      `${String(ts.answer).padStart(12)}   ${ts.answer === nt.answer ? 'yes' : `NO (${nt.answer})`}`,
  );
}

nat.free();
