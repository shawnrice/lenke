/**
 * ⚠️⚠️ **IS A SECOND PROJECTED PROPERTY REALLY FREE? (item 2344)**
 *
 * `docs/guides/query-cost.md`'s "Name the properties you need" says a second property is **free** — 27 ns a
 * row for `RETURN n.name` and 27 ns for `RETURN n.name, n.team` — because "the cost is reaching the
 * element, not reading its fields".
 *
 * ⚠️ **But item 2332 measured the opposite on a two-hop shape**: `RETURN c.k` at 96.54 ns a row against
 * `RETURN a.k, c.k` at 139.29 — a second column costing 44%.
 *
 * 🔑 **The likely reconciliation is that the guide's two properties come from the SAME variable and item
 * 2332's from DIFFERENT ones** — so "reaching the element" is paid once per element, not once per query.
 * ✅ If that holds, the rule is true but incomplete, and incomplete in a way that misleads: a reader
 * concludes extra columns are free, when a column from a second element is not.
 *
 * ⚠️ These arms separate the two, and re-verify the guide's own three numbers while they are at it.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 1);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'oneProp';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['N'],
    properties: { name: `n${i}`, team: `t${i % 50}`, k: i % 97 },
  });
}

/* ✅ Exactly one edge per vertex, so the hop arms emit the same row count as the scan arms. */
const seen = new Set();

for (let j = 0; j < NODES * FAN; j += 1) {
  const to = ((j % NODES) * 104_729 + Math.floor(j / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${j}`,
    from: graph.getVertexById(`v${j % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
}

if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: ${seen.size} distinct endpoints of ${NODES}`);
}

const TEXTS = {
  /* ✅ THE GUIDE's THREE ROWS, re-verified. */
  oneProp: 'MATCH (n:N) RETURN n.name AS name',
  twoPropsSame: 'MATCH (n:N) RETURN n.name AS name, n.team AS team',
  element: 'MATCH (n:N) RETURN n AS n',
  /* ⚠️ THE OMITTED CASE: two columns from DIFFERENT elements, which needs a hop to have two. */
  oneHopFar: 'MATCH (a:N)-[:E]->(b) RETURN b.name AS bn',
  twoPropsDifferent: 'MATCH (a:N)-[:E]->(b) RETURN a.name AS an, b.name AS bn',
  /* ✅ And two props from the SAME far element, over the same hop — isolates "second element" from "hop". */
  twoPropsSameFar: 'MATCH (a:N)-[:E]->(b) RETURN b.name AS bn, b.team AS bt',
};

const text = TEXTS[ARM];

/*
 * ⚠️⚠️ **SERIALIZATION IS THE RECONCILIATION, AND IT MUST BE MEASURED NOT ASSUMED (item 2344).** The guide
 * claims `RETURN n` is 4.1x a named projection; in-process it measures CHEAPER (15.5 against 20.7 ns),
 * because it hands back a REFERENCE to the live element. 🔑 The guide's own text says why its number
 * differs: *"the flat `{id, labels, properties}` map is what a SERIALIZER builds from it, and building it
 * is the cost"*. ✅ So `SERIALIZE=1` puts the rows through `JSON.stringify`, which is what an HTTP
 * handler does — if the 4.1x is a serialization cost, it appears only there.
 */
const SERIALIZE = process.env.SERIALIZE === '1';
/*
 * ⚠️ THE FIRST VERSION RAN THE QUERY TWICE — `JSON.stringify(query(...)).length && query(...).length` —
 * which inflated both arms' absolutes while roughly preserving their ratio. ✅ One query, then serialize
 * its rows, then report the row count from the same result.
 */
const run = () => {
  const rows = query(graph, text);

  if (SERIALIZE) {
    JSON.stringify(rows);
  }

  return rows.length;
};

for (let w = 0; w < 20; w += 1) {
  run();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 20_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = run();

console.log(
  `  ARM=${ARM.padEnd(18)} ${((med * 1_000_000) / rows).toFixed(1).padStart(7)} ns/row  rows=${rows}`,
);
