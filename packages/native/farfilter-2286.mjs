/**
 * ⚠️⚠️⚠️ **ONE SHAPE PER PROCESS, BECAUSE THE GUIDE'S CLAIM CAME FROM A NINE-SHAPE PROCESS (item 2286).**
 *
 * Item 2283 timed nine query shapes in one process and published the gap between two of them as a rule in
 * `docs/guides/query-cost.md`: an unfiltered hop count at 0.00 ms against 4.6 ms with a far-end filter.
 * 🔑 Item 2285 then showed that extra arms in one process can **erase** a real 2.17x — so the same mechanism
 * can just as easily **manufacture** a gap, and this one is in a user-facing document.
 *
 * ✅ `SHAPE` selects exactly one query. Each arm therefore runs in its own process with its own dispatch
 * sites, which is the only configuration item 2285 leaves trustworthy.
 *
 * ⚠️ The fixture is identical in both arms — same graph, same edges, same seed — so the only difference is
 * the query text. Both arms also print their answer, because a cost comparison between two queries that
 * return different row counts is not a comparison at all.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const SHAPE = process.env.SHAPE ?? 'unfiltered';

const g = new Graph();
const TEAMS = ['core', 'platform', 'data', 'infra'];

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: { name: `n${i}`, team: TEAMS[i % 4] },
  });
}

let s = 0x5eed | 0;
const rnd = () => {
  s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

  return (s >>> 1) % 1_000_000_007;
};

for (let i = 0; i < N; i += 1) {
  for (let f = 0; f < 3; f += 1) {
    const to = g.getVertexById(`p${(rnd() + f * 7919) % N}`);

    if (to) {
      g.addEdge({
        id: `e${i}_${f}`,
        from: g.getVertexById(`p${i}`),
        to,
        labels: ['WORKS_WITH'],
        properties: {},
      });
    }
  }
}

const QUERIES = {
  unfiltered: ['MATCH (p:Person)-[:WORKS_WITH]->(q:Person) RETURN count(*) AS c', {}],
  farfilter: [
    'MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE q.team = $t RETURN count(*) AS c',
    { t: 'core' },
  ],
  nearfilter: [
    'MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE p.team = $t RETURN count(*) AS c',
    { t: 'core' },
  ],
  vacuous: ['MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE true RETURN count(*) AS c', {}],
};

const [text, params] = QUERIES[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/*
 * ⚠⚠ **INNER ITERATIONS, BECAUSE THE FAST ARM IS SUB-MICROSECOND (item 2303).** This file's first
 * version wrapped ONE query in a `performance.now()` pair with 3 warm-ups, and reported the unfiltered hop
 * count at "0.01 ms" — a figure the guide then quoted. 🔑 At that scale the clock and the JIT dominate: item
 * 2302 found a median-of-9 understating an indexed lookup by 17x, and `gremlin-spelling-probe` had already
 * solved it at item 1644 by calibrating an inner count until a sample takes at least `SAMPLE_MS` and
 * reporting the PER-CALL time. That is what this now does.
 */
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 25);

for (let w = 0; w < 200; w += 1) {
  query(g, text, params);
}

/* Calibrate: grow the inner count until one sample is long enough to measure against the clock. */
let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    query(g, text, params);
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 1_000_000) {
    break;
  }

  inner *= 2;
}

const ts = [];
let answer = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  for (let i = 0; i < inner; i += 1) {
    answer = query(g, text, params)[0].c;
  }

  ts.push((performance.now() - t) / inner);
}

console.log(
  `  SHAPE=${SHAPE.padEnd(11)} median ${med(ts).toFixed(4).padStart(9)} ms   inner=${inner}   answer=${answer}`,
);
