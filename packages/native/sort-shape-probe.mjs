/**
 * Item 1715: HOW MUCH OF ITEM 1711'S WIN DEPENDS ON THE STRING SHAPE?
 *
 * The sweep row `traverse 1-hop project + order by` moved 1.01x-1.03x while the isolated
 * `hopsortstr` moved 1.45x-1.71x. Both reach the SAME sort site and both are ADMITTED by the scan
 * (verified with a counter), and the sort is 63% of the sweep row, so neither routing nor share
 * explains it. The difference is the STRINGS.
 *
 * Item 921's own table already separates these cases and I did not read across to it:
 *
 *     data        floor      ref     scan    ref/scan
 *     ascii         0.8      2.1      1.9       1.08x
 *     prefixed      1.2      2.7      9.5       0.28x   <- a LONG SHARED PREFIX is a different case
 *
 * `bench.ts` names are `person${i}` — every pair shares "person", so the native `<` compare walks
 * 6+ units before deciding and the dispatch chain removed by the specialization is a SMALLER share
 * of each comparison. The isolated harness uses `s${i % 1000}`, 2-5 chars, where the compare is
 * nearly free and the dispatch dominates.
 *
 * Four columns on ONE fixture and ONE process per column, so the only thing differing is the shape:
 *
 *     short     s0..s999        2-5 chars, 1000 distinct  (the isolated harness's shape)
 *     prefixed  person0..       long shared prefix        (the sweep's shape)
 *     uniqshort u0..            short AND unique          (isolates length from uniqueness)
 *     longuniq  a 24-char random-ish unique string        (long, no shared prefix)
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);
const DROP = Number(process.env.DROP ?? 3);
const COL = process.env.COL ?? 'short';

const pad = (n) => String(n).padStart(7, '0');
const value = (i) => {
  if (COL === 'short') {
    return `s${i % 1000}`;
  }

  if (COL === 'prefixed') {
    return `person${i}`;
  }

  if (COL === 'uniqshort') {
    return `u${i.toString(36)}`;
  }

  return `${((i * 2654435761) % 4294967296).toString(36)}-${pad(i)}-tail`;
};

/**
 * ⚠️ `benchlike` REPLICATES `bench.ts`'s FIXTURE EXACTLY, and it exists because every hand-built
 * column above wins while the sweep row does not. The specialization is reached and ADMITTED on both
 * (counter-verified, on a decoded graph as well as a hand-built one) and the sort is 63% of the sweep
 * row, so neither routing, nor share, nor the string shape explains the gap. What is left is how the
 * GRAPH is built: `bench.ts` DECODES NDJSON and gives each vertex THREE properties, where the columns
 * above use `addVertex` and one. If `benchlike` wins, the difference is the HARNESS (min-of-5 against
 * a trimmed median); if it does not, it is the FIXTURE, and the next step is to vary one at a time.
 */
const build = () => {
  if (COL !== 'benchlike') {
    const g = new Graph();

    for (let i = 0; i < N; i += 1) {
      g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { k: value(i) } });
    }

    for (let k = 0; k < N * 5; k += 1) {
      const i = k % N;
      g.addEdge({
        id: `e${k}`,
        from: g.getVertexById(`v${i}`),
        to: g.getVertexById(`v${(i * 7 + Math.floor(k / N)) % N}`),
        labels: ['KNOWS'],
      });
    }

    return g;
  }

  // bench.ts's own lines, property order and all: `{"age":…,"name":"person…","city":"city…"}`.
  const doc = [];

  for (let i = 0; i < N; i += 1) {
    doc.push(
      `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90},"name":"person${i}","city":"city${i % 8}"}}`,
    );
  }

  for (let k = 0; k < N * 5; k += 1) {
    const i = k % N;
    doc.push(
      `{"type":"edge","id":"e${k}","from":"v${i}","to":"v${(i * 7 + Math.floor(k / N)) % N}","labels":["KNOWS"]}`,
    );
  }

  return deserialize(doc.join('\n'), 'ndjson', new Graph());
};

const g = build();
const Q =
  COL === 'benchlike'
    ? 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n'
    : 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.k AS n ORDER BY n';
const series = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  const out = query(g, Q);
  series.push(performance.now() - t);
  rows = out.length;
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const sample = COL === 'benchlike' ? 'person0' : value(0);

console.log(
  JSON.stringify({
    col: COL,
    sampleValue: sample,
    sampleLen: sample.length,
    rows,
    median: kept[Math.floor(kept.length / 2)],
    min: Math.min(...series),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
