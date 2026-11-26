// RETIRED AS A CONTRACT (item 2400, 2026-11-22) -- KEPT AS AN INSTRUMENT.
//
// This probe's finding is still TRUE: native's tie order under `ORDER BY` follows the
// START-DRIVEN arrival order, and a far-driven walk would differ. What changed is that this is no
// longer a cross-engine CONTRACT. Walk order is implementation-dependent (item 2400), and a tie
// under a sort is resolved by walk arrival order, so an equal-key group is a MULTISET -- which is
// what the GQL differential fuzzer already assumed, its own words being that comparing a tie
// "would report the engines' free choice as a bug".
//
// So this probe must NOT be read as a refusal any more. The far-driven deferred-hop fold it
// blocked (item 1966's 198 ns/row, 67% of that shape) is UNBLOCKED. Keep the probe: it still
// answers "which order does this engine actually produce", which is worth knowing when a
// reordering change needs explaining -- and its printed `DIFFER? true` vacuity guard is the
// reusable part.
//
// Item 1968 — WHICH ARRIVAL ORDER DOES NATIVE'S TIE ORDER CORRESPOND TO?
//
// Item 1967 relocated the blocker: `walkReadFlags` forces the deferred hop arm to bind the start,
// so the far-driven template fold (which would fold item 1966's 198 ns/row key term by the fan-in)
// is unreachable. Computing `keysReadStart` from the AST would unlock it — but a far-driven walk
// visits rows in a DIFFERENT arrival order, and `Array.prototype.sort` is stable, so TIE ORDER under
// `ORDER BY` would change. Item 605 established that tie order is observable between the engines.
//
// SO THE QUESTION IS ANSWERABLE WITHOUT BUILDING ANYTHING. Construct a fixture where the
// start-driven and far-driven arrival orders DIFFER even after a stable sort, compute both candidate
// orders BY HAND, and ask which one the NATIVE engine's output matches. If native matches
// start-driven, a far-driven TS deferred arm is a cross-engine wrong answer and the fold is dead.
// If it matches far-driven, TS is the one that is out of step and the fold is not merely available
// but owed.
//
// THE FIXTURE HAS TO MAKE THE TWO ORDERS DIFFER, which needs care: rows for one far vertex share
// its key, so after sorting they are adjacent either way, and a fixture keyed on the FAR end cannot
// tell the orders apart. So the sort key reads the START (`a.k`), while the projected tag reads the
// FAR end — then a far-driven walk interleaves start keys and a start-driven one groups them.
//
//     bun tiewalk-1968.mjs
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

if (!nativeReady) {
  console.log('SKIP: the native engine library is not built');
  process.exit(0);
}

const N = 8;
const FAN = 2;
// `k` on the START decides the sort; two values, so every group is a big tie.
const kOf = (i) => i % 2;
const lines = [];

for (let i = 0; i < N; i += 1) {
  lines.push(
    `{"type":"node","id":"${String(i + 1)}","labels":["T"],"properties":{"k":${String(kOf(i))},"tag":"v${String(i + 1)}"}}`,
  );
}

/** The edge list, in INSERTION order: (from, to) pairs. */
const edges = [];

for (let i = 0; i < N; i += 1) {
  for (let j = 1; j <= FAN; j += 1) {
    edges.push([i, (i + j) % N]);
  }
}

let e = 0;

for (const [from, to] of edges) {
  lines.push(
    `{"type":"edge","id":"e${String(e)}","labels":["E"],"from":"${String(from + 1)}","to":"${String(to + 1)}","properties":{}}`,
  );
  e += 1;
}

const NDJSON = lines.join('\n');
const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

/** A STABLE sort by the start key, over a candidate arrival order of (start, far) pairs. */
const sortedBy = (arrival) =>
  [...arrival.entries()]
    .map(([at, pair]) => ({ at, k: kOf(pair[0]), tag: `v${String(pair[1] + 1)}` }))
    .sort((x, y) => (x.k === y.k ? x.at - y.at : x.k - y.k))
    .map((r) => r.tag)
    .join(',');

// START-DRIVEN: each start vertex in id order, each of its out-edges in insertion order.
const startArrival = [];

for (let i = 0; i < N; i += 1) {
  for (const [from, to] of edges) {
    if (from === i) {
      startArrival.push([from, to]);
    }
  }
}

// FAR-DRIVEN: each FAR vertex in id order, each of its in-edges in insertion order.
const farArrival = [];

for (let t = 0; t < N; t += 1) {
  for (const [from, to] of edges) {
    if (to === t) {
      farArrival.push([from, to]);
    }
  }
}

const startOrder = sortedBy(startArrival);
const farOrder = sortedBy(farArrival);

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN b.tag AS t ORDER BY a.k + 0';
const seqOf = (rows) => rows.map((r) => r.t).join(',');
const tsOut = seqOf(tsQuery(tsGraph, Q));
const natOut = seqOf(nativeGraph.query(Q));

console.log(`hand START-driven : ${startOrder}`);
console.log(`hand FAR-driven   : ${farOrder}`);
console.log(`TS engine         : ${tsOut}`);
console.log(`NATIVE engine     : ${natOut}`);

// THE VACUITY GUARD, and this probe is useless without it: if the two hand orders coincide the
// fixture cannot tell them apart, and "native matches start-driven" would be unearned.
console.log(
  `\nthe two hand orders DIFFER? ${String(startOrder !== farOrder)}   <- if false, the fixture proves nothing`,
);
console.log(`TS == native?   ${String(tsOut === natOut)}`);
console.log(
  `native matches: start-driven=${String(natOut === startOrder)}  far-driven=${String(natOut === farOrder)}`,
);
