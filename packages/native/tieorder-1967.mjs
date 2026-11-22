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
// Item 1967 — IS `deferredHopOrder`'s `startDriven: true` LOAD-BEARING FOR TIE ORDER?
//
// Item 1966 priced the deferred hop arm's sort-key evaluation at 67% of the shape and found the
// obvious fix — the far-driven template fold, which evaluates a far-only key once per far vertex —
// unreachable because `deferredHopOrder` forces the start-driven walk. It did NOT establish why.
//
// ⚠️ NEITHER SUITE CAN ANSWER THIS, which is why a probe exists. With the flag flipped to `false`
// the gql suite is 4948/0 and `bun run fuzz` is 57/0 — but the GQL differential fuzzer compares as
// a ROW MULTISET and appends a final sort key to every `ORDER BY` query precisely so that row order
// is not compared. A tie-order change is invisible to both by construction.
//
// 🔑 SO ASK THE CONTRACT DIRECTLY: run a TIE-HEAVY deferred hop sort through the TS engine and the
// NATIVE engine and compare POSITIONALLY. Item 605 established that tie order is observable between
// the engines, so if the two disagree the flag is load-bearing and the fold is blocked; if they
// agree with the flag flipped, the fold is available and item 1966's lever is unlocked.
//
// ⚠️ THE FIXTURE MUST HAVE TIES ON THE SORT KEY, and a fan-in above 1, or the question cannot be
// asked: with distinct keys every arrival order yields the same sorted sequence, which is the
// vacuous-pass trap. `k` takes four values over twelve vertices and every far vertex has several
// in-edges.
//
//     bun tieorder-1967.mjs
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

if (!nativeReady) {
  console.log('SKIP: the native engine library is not built');
  process.exit(0);
}

const lines = [];

for (let i = 0; i < 12; i += 1) {
  // `k` ties in groups of three; `tag` records arrival order so a tie's resolution is readable.
  lines.push(
    `{"type":"node","id":"${String(i + 1)}","labels":["T"],"properties":{"k":${String(i % 4)},"tag":"v${String(i + 1)}"}}`,
  );
}

let e = 0;

for (let i = 0; i < 12; i += 1) {
  // Fan-in 3 on every far vertex, so a far-driven walk and a start-driven walk visit the same
  // edges in genuinely different orders.
  for (let j = 1; j <= 3; j += 1) {
    lines.push(
      `{"type":"edge","id":"e${String(e)}","labels":["E"],"from":"${String(i + 1)}","to":"${String(((i + j) % 12) + 1)}","properties":{}}`,
    );
    e += 1;
  }
}

/** The ORDERED rendering of a result, so a positional comparison is a string comparison. */
const seq = (rows) => rows.map((r) => JSON.stringify(r)).join('|');

const NDJSON = lines.join('\n');
const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

/*
 * Each shape must reach the DEFERRED arm, which needs a sort key the column arm cannot resolve to
 * a projected column — a computed key, or a window over a faultable item. A bare `ORDER BY x` would
 * take the column arm and answer the wrong question.
 */
const SHAPES = [
  ['computed key, no window', 'MATCH (a:T)-[:E]->(b:T) RETURN b.tag AS t ORDER BY b.k + 0'],
  ['computed key, LIMIT', 'MATCH (a:T)-[:E]->(b:T) RETURN b.tag AS t ORDER BY b.k + 0 LIMIT 8'],
  ['computed item and key', 'MATCH (a:T)-[:E]->(b:T) RETURN b.k + 0 AS c, b.tag AS t ORDER BY c'],
  ['key reads the START', 'MATCH (a:T)-[:E]->(b:T) RETURN b.tag AS t ORDER BY a.k + 0'],
];

let disagree = 0;

for (const [name, q] of SHAPES) {
  const ts = tsQuery(tsGraph, q);
  const nat = nativeGraph.query(q);
  const tsSeq = seq(ts);
  const natSeq = seq(nat);
  const multisetSame =
    seq([...ts].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))) ===
    seq([...nat].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)));

  if (tsSeq !== natSeq) {
    disagree += 1;
  }

  /*
   * ⚠️ THE VACUITY GUARD. "TS agrees with native" means nothing unless the flag under test actually
   * CHANGES the TS order for this shape — otherwise both builds agree with native and the probe has
   * measured nothing. `gremlin-order-by-key-parity.ts` was vacuous on its first run for exactly this
   * reason. The digest is printed ALWAYS, so the two builds can be diffed.
   */
  const digest = ts.map((r) => String(Object.values(r).at(-1))).join('');

  console.log(
    `${name.padEnd(26)} ordered=${String(tsSeq === natSeq).padEnd(5)} multiset=${String(multisetSame).padEnd(5)} rows=${String(ts.length)}/${String(nat.length)}  tsDigest=${digest.slice(0, 48)}`,
  );

  if (tsSeq !== natSeq) {
    console.log(`    ts  : ${tsSeq.slice(0, 160)}`);
    console.log(`    nat : ${natSeq.slice(0, 160)}`);
  }
}

console.log(
  `\n${disagree === 0 ? 'ALL AGREE POSITIONALLY' : `⚠️ ${String(disagree)} SHAPE(S) DISAGREE ON ORDER`}`,
);
