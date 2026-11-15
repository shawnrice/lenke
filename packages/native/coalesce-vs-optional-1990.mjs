// Item 1990 — `coalesce(out(T), identity())` against `optional(out(T))`, which are the SAME QUESTION.
//
// ⚠️⚠️ **THESE TWO SPELLINGS HAVE DIFFERENT HISTORIES AND THAT IS THE POINT.** `optional` has two
// dedicated fused modules (`optional-hop.ts`, `optional-hop-values.ts`, the second riding item
// 1889's CSR behind the second-ask policy) and the workload screen puts `optional: hop` at 46.24 ms
// against a bare `hop1: values`'s 45.88 — i.e. essentially FREE. `coalesce` has no module at all:
// item 1629 gave `coalesceStep` a direct adjacency-bucket read worth **1.26x** and item 1480 records
// the structural reason neither could be fused properly — "the fused walks are SOURCE-ANCHORED, so
// no sub-plan can reach them".
//
// 🔑 SO THE QUESTION IS WHETHER THE STRUCTURAL BLOCKER STILL BINDS *coalesce* AFTER `optional` GOT
// AROUND IT. `optional(X)` and `coalesce(X, identity())` emit the same rows in the same order: both
// run X per incoming traverser and fall back to the input when X is empty. If one is 1.0x a bare hop
// and the other is several x, that is this repo's named defect class between two spellings of one
// question — and the cure already exists one shape over.
//
// ⚠️ ONE SHAPE PER PROCESS (item 762): with several shapes in one run the shared dispatch site is
// polymorphic and the figure belongs to the mix. Item 1988 measured that at 1.3-1.56x on this very
// screen's rows, so the arms here are selected by argv.
//
// ⚠️ THE ANSWERS ARE COMPARED ELEMENT FOR ELEMENT, not as a multiset. Gremlin stream order is a
// TinkerPop contract that the differential fuzzer compares ORDERED for a single-type step
// ([[order-is-unspecified]] does not cover it), so a route that reorders is wrong, not merely
// different — and a checksum cannot see that (item 1955).
//
//     bun coalesce-vs-optional-1990.mjs            # all arms, answers compared, then times
//     ARM=coalesce bun coalesce-vs-optional-1990.mjs
import { Graph } from '@lenke/core';
import { identity, coalesce, optional, out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 7);
const { ARM } = process.env;
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['P'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // The workload screen's generator, verbatim — split on the REPEAT INDEX (CLAUDE.md's rule).
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

/*
 * ⚠️ A VERTEX WITH NO `E` EDGES IS ADDED DELIBERATELY. `optional` and `coalesce(…, identity())`
 * differ from a bare hop ONLY on the rows the hop misses, so a fixture where every vertex has an
 * out-edge cannot tell the three apart — the fallback arm would never run and the comparison would
 * measure a plain hop three times. The screen's generator gives every vertex degree FANOUT.
 */
g.addVertex({ id: 'lonely', labels: ['P'], properties: { n: 999 } });

const ARMS = {
  // The bare hop — the FLOOR, and not a valid ceiling for the other two: it emits nothing for the
  // vertex they emit a fallback row for, so it does strictly less work (item 1951's rule).
  hop: () => traversal(V(), out('E'), values('n')),
  optional: () => traversal(V(), optional(out('E')), values('n')),
  coalesce: () => traversal(V(), coalesce(out('E'), identity()), values('n')),
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const run = (name) => {
  const build = ARMS[name];
  const ts = [];
  let rows = 0;
  let digest = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = toArray(build(), g);

    ts.push(performance.now() - t0);
    rows = got.length;

    if (r === 0) {
      // ⚠️ A PREFIX AND A SUFFIX, POSITIONALLY — not a checksum. An order change is exactly what a
      // checksum cannot see, and it is the failure mode this family would have.
      digest = `${JSON.stringify(got.slice(0, 6))}…${JSON.stringify(got.slice(-3))}`;
    }
  }

  return { ms: med(ts), rows, digest };
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)} REPS=${String(REPS)} median`,
);
console.log('# `lonely` has no E edges, so optional/coalesce emit one row a bare hop does not\n');
console.log('arm            ms      rows   ns/row   first 6 … last 3');

const names = ARM === undefined ? Object.keys(ARMS) : [ARM];
const out_ = [];

for (const name of names) {
  const got = run(name);

  out_.push([name, got]);
  console.log(
    `${name.padEnd(12)} ${got.ms.toFixed(2).padStart(7)} ${String(got.rows).padStart(8)} ${((got.ms * 1e6) / got.rows).toFixed(0).padStart(7)}   ${got.digest}`,
  );
}

if (out_.length === 3) {
  const by = Object.fromEntries(out_);

  console.log(
    `\noptional / hop   ${(by.optional.ms / by.hop.ms).toFixed(2)}x` +
      `   coalesce / hop   ${(by.coalesce.ms / by.hop.ms).toFixed(2)}x` +
      `   coalesce / optional   ${(by.coalesce.ms / by.optional.ms).toFixed(2)}x`,
  );
  console.log(
    `optional and coalesce agree on rows: ${String(by.optional.rows === by.coalesce.rows)}` +
      `   and positionally: ${String(by.optional.digest === by.coalesce.digest)}`,
  );
}
