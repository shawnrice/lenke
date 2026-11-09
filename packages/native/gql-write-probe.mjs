/**
 * THE GQL WRITE PATH, which no screen covers (item 1763).
 *
 * `runtime-profile-probe.mjs` has 50-odd shapes and every one is a READ. Items 1732-1734 profiled
 * the core write path (`Vertex.setProperty`) directly, but a write issued as a QUERY goes through
 * parse, plan, the clause runner and the write executor first — and none of that has been profiled.
 *
 * ⚠️ A WRITE PROBE CANNOT REUSE ITS FIXTURE. Every rep mutates, so the graph grows (INSERT) or the
 * rows change (SET on a widening set). Two consequences the read probes never face:
 *
 *   1. the fixture is rebuilt per BATCH, and the rebuild is outside the measured window;
 *   2. the per-rep cost is only comparable within a batch, so the batch size is part of the result.
 *
 * ⚠️ AND THE ANSWER IS ASSERTED, by counting elements after the batch — item 1749's lesson. A write
 * that silently did nothing would otherwise be the fastest arm in any A/B.
 *
 *     SHAPE=insert node gql-write-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const SEED = Number(process.env.SEED ?? 2000);
const BATCH = Number(process.env.BATCH ?? 2000);
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const SHAPE = process.env.SHAPE ?? 'insert';

/**
 * ⚠️ `INDEXED=1` IS NOT OPTIONAL FOR READING THE WRITE PATH, and the first run of this probe proved
 * it. Unindexed, `set` measured 80.78 µs and `insertedge` 155.52 against `insert`'s 5.96 — and
 * almost all of that gap is the MATCH scanning 2,000 vertices, not the write, which items 1732-1734
 * measured at ~121 ns. A probe named "write" that is 99% scan is the same defect item 1754 found in
 * the two frame screens, one new probe later.
 */
const seeded = () => {
  const g = new Graph();

  for (let i = 0; i < SEED; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
  }

  if (process.env.INDEXED === '1') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  }

  return g;
};

/**
 * ⚠️ A LITERAL TEMPLATE IS A PARSE-CACHE MISS PER REP, and the first profile of this probe is how
 * that was found: `tokenize` 10.7%, `normalizeLiterals` 5.1%, `digits` 4.0%, `parseCached` 3.0% —
 * about 23% of an "INSERT" was PARSING, because `INSERT (:P {n: 2001, …})` is a different string
 * every rep and `parseCached` keys on text. A real application parameterises, so the `p`-suffixed
 * shapes below are the ones that measure the engine rather than the probe; the literal ones are
 * kept because the GAP between them is a user-facing number (what not parameterising costs).
 */
/** Each shape: a query template, and the element delta one batch must produce. */
const SHAPES = {
  // One vertex per rep, with properties — the plainest write.
  insert: {
    q: (i) => `INSERT (:P {n: ${SEED + i}, k: ${i % 97}})`,
    expect: (g) => g.vertexCount === SEED + BATCH,
  },
  // A property write on an existing vertex, routed through the GQL clause runner.
  set: {
    q: (i) => `MATCH (n:P) WHERE n.n = ${i % SEED} SET n.k = ${i % 97}`,
    expect: (g) => g.vertexCount === SEED,
  },
  // An edge insert between two existing vertices — the shape ingest actually pays for.
  insertedge: {
    q: (i) =>
      `MATCH (a:P), (b:P) WHERE a.n = ${i % SEED} AND b.n = ${(i * 7) % SEED} INSERT (a)-[:E]->(b)`,
    expect: (g) => g.edgeCount === BATCH,
  },
  // PARAMETERISED twins: one query text, so the parse and plan caches hit as they would in an app.
  insertp: {
    q: () => 'INSERT (:P {n: $n, k: $k})',
    params: (i) => ({ n: SEED + i, k: i % 97 }),
    expect: (g) => g.vertexCount === SEED + BATCH,
  },
  setp: {
    q: () => 'MATCH (n:P) WHERE n.n = $n SET n.k = $k',
    params: (i) => ({ n: i % SEED, k: i % 97 }),
    expect: (g) => g.vertexCount === SEED,
  },
  insertedgep: {
    q: () => 'MATCH (a:P), (b:P) WHERE a.n = $a AND b.n = $b INSERT (a)-[:E]->(b)',
    params: (i) => ({ a: i % SEED, b: (i * 7) % SEED }),
    expect: (g) => g.edgeCount === BATCH,
  },
};

const shape = SHAPES[SHAPE];

if (shape === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const series = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const g = seeded();
  const t = performance.now();

  await profileWindow(r === ROUNDS - 1 ? process.env.PROF_OUT : undefined, () => {
    for (let i = 0; i < BATCH; i += 1) {
      query(g, shape.q(i), shape.params === undefined ? undefined : shape.params(i));
    }

    return g.vertexCount;
  });

  series.push(performance.now() - t);

  // Asserted per round: a write that did nothing would be the fastest arm in any comparison.
  if (!shape.expect(g)) {
    throw new Error(
      `${SHAPE} round ${r}: ${g.vertexCount} vertices / ${g.edgeCount} edges — the batch did not apply`,
    );
  }
}

const kept = [...series].sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  JSON.stringify({
    shape: SHAPE,
    seed: SEED,
    batch: BATCH,
    medianMs: Number(median.toFixed(1)),
    usPerWrite: Number(((median * 1000) / BATCH).toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
