/**
 * Does the INLINE-BRACES spelling seek an index inside a comma product, the way its twins do?
 *
 * Item 1333. The GQL spelling probe flags `a product's one-sided predicate` right at its 2x
 * threshold, and five separate processes show why the group ratio flickers while the effect does
 * not — the braces arm is rock steady and the others vary:
 *
 *     , (b:P) WHERE b.k = 7      14.20 14.23 14.12 12.21 14.22   median 14.20
 *     MATCH … MATCH … WHERE      11.39 12.83 10.37 10.88 13.11   median 11.39
 *     , (b:P WHERE b.k = 7)      11.48 11.85 11.82 12.26 11.64   median 11.82
 *     , (b:P {k: 7})             23.72 24.69 24.78 25.35 23.64   median 24.69  <- 2.09x
 *
 * ONE SHAPE PER PROCESS, and `IDX=0` beside `IDX=1` rather than after it — item 1330's lesson,
 * where measuring only the indexed state would have shipped a 2.9x regression. If the braces arm
 * reads the same with and without an index while its twins drop, it is not seeking.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const SHAPE = process.env.SHAPE ?? 'braces';

const SHAPES: Record<string, string> = {
  // The four spellings the probe compares, named for what differs.
  clause: `MATCH (a:S), (b:P) WHERE b.k = 7 RETURN b.k AS x`,
  twoMatch: `MATCH (a:S) MATCH (b:P) WHERE b.k = 7 RETURN b.k AS x`,
  inlineWhere: `MATCH (a:S), (b:P WHERE b.k = 7) RETURN b.k AS x`,
  braces: `MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x`,
  // Controls: the SAME inline-braces spelling without a product, to separate "braces are slow"
  // from "braces are slow IN a product".
  bracesAlone: `MATCH (b:P {k: 7}) RETURN b.k AS x`,
  inlineWhereAlone: `MATCH (b:P WHERE b.k = 7) RETURN b.k AS x`,
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  console.log(`arms: ${Object.keys(SHAPES).join(' ')}`);
  process.exit(2);
}

/**
 * `LOAD=ndjson` builds the graph the way the spelling probe does — `deserialize` over NDJSON — and
 * `LOAD=api` uses `addVertex`. Worth separating: the repo records that TS ingest is `JSON.parse` +
 * alloc + FREEZE, and a frozen property object has a different hidden class from one built by the
 * API, so the two can take different property-access paths at the same shape.
 */
const NDJSON = process.env.LOAD === 'ndjson';

const g = new Graph();

// IDX=1 builds the index BEFORE the rows, IDX=2 BACKFILLS it after — which is what the spelling
// probe does, and the two are worth separating: a backfilled index that some route cannot use
// would show up here and nowhere else.
if (process.env.IDX === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

/**
 * `k: i % 50`, NOT `k: i`, and that is the whole difference between measuring this and measuring
 * nothing. The spelling probe's fixture uses `i % 50`, so `k = 7` matches 4,000 of 200,000 and the
 * comma product yields ~16,000 rows — which is the work the two spellings disagree about.
 *
 * ⚠️ THE FIRST VERSION OF THIS PROBE USED A UNIQUE `k`. One match, eight rows, no per-row cost,
 * and every arm read 0.042-0.055 ms with an index — from which the conclusion would have been
 * "there is no gap when indexed", the exact opposite of what the spelling probe measures on its
 * own fixture. An answer INVARIANT to the property under test cannot validate the fixture.
 */
/**
 * `PROPS=rich` matches the spelling probe's own vertices — three labels and four properties
 * including a NESTED map — and `PROPS=lean` is one label and one property. Bisecting that,
 * because a minimal fixture did NOT reproduce the gap the shared one shows, and the most likely
 * reason a braces predicate would cost more per row than an inline `WHERE` is the size of the
 * property bag it reads.
 */
const RICH = process.env.PROPS === 'rich';

const labelsOf = (i: number): string[] => {
  if (!RICH) {
    return ['P'];
  }

  return i % 3 === 0 ? ['P', 'Q', 'Univ'] : ['P', 'Univ'];
};

const propsOf = (i: number): Record<string, unknown> =>
  RICH ? { k: i % 50, s: `s${i % 7}`, flag: i % 5 !== 0, meta: { s: `s${i % 7}` } } : { k: i % 50 };

if (NDJSON) {
  const lines: string[] = [];

  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({ type: 'node', id: `v${i}`, labels: labelsOf(i), properties: propsOf(i) }),
    );
  }

  for (let i = 0; i < 4; i++) {
    lines.push(
      JSON.stringify({
        type: 'node',
        id: `s${i}`,
        labels: RICH ? ['S', 'Univ'] : ['S'],
        properties: { k: i },
      }),
    );
  }

  tsDeserialize(lines.join('\n'), 'ndjson', g);
} else {
  for (let i = 0; i < N; i++) {
    g.addVertex({ id: `v${i}`, labels: labelsOf(i), properties: propsOf(i) });
  }
}

// FOUR S vertices, matching the spelling probe's own fixture: a comma product needs a tiny left
// side or |left| x |right| is a hang rather than a measurement, and 4 is what that probe chose.
if (!NDJSON) {
  for (let i = 0; i < 4; i++) {
    g.addVertex({ id: `s${i}`, labels: RICH ? ['S', 'Univ'] : ['S'], properties: { k: i } });
  }
}

if (process.env.IDX === '2') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

// The last two differences from the spelling probe's fixture, added TOGETHER because three
// one-at-a-time candidates have already been refuted (property richness, index-build order, the
// NDJSON load path) and guessing one factor per run is the expensive way to do this.
if (process.env.EDGES === '1') {
  for (let e = 0; e < N * 3; e++) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${(e * 104729) % N}`)!,
      to: g.getVertexById(`v${(e * 7919) % N}`)!,
      labels: e % 11 === 0 ? ['E', 'F'] : ['E'],
      properties: { w: e % 5, ew: e % 1000 },
    });
  }
}

if (process.env.IDX2 === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['s'] });
}

/**
 * `MULTI=1` runs the FOUR spellings in ONE process, two passes with the min per spelling — exactly
 * how the spelling probe measures a group — instead of one shape per process.
 *
 * This is the last difference left after four refutations, and it is the one the repo warns about
 * loudest: "one shape per PROCESS, so no other shape pollutes the dispatch" (items 762 and 1320).
 * The spelling probe's own header records items 180 and 181 reporting a group at 1.5-2.1x with no
 * engine cause at all, fixed by timing both positions — but both positions still share one
 * process, so a shape that ends up megamorphic there stays megamorphic in both passes.
 */
if (process.env.MULTI === '1') {
  const group = ['clause', 'twoMatch', 'inlineWhere', 'braces'];
  const timeOne = (name: string): number => {
    const reps: number[] = [];

    for (let r = 0; r < REPS; r++) {
      const t0 = performance.now();
      // NOPARAMS=1 calls `query(g, q)` with no third argument, which is what the spelling probe
      // does. `query(g, q, {})` passes a FRESH object literal on every call, and there are parse
      // and plan caches (items 228 and 229) — so the two spellings of the CALL are worth
      // separating from the two spellings of the QUERY.
      const rows =
        process.env.NOPARAMS === '1' ? query(g, SHAPES[name]) : query(g, SHAPES[name], {});

      reps.push(performance.now() - t0);

      // STRINGIFY=1 reproduces the spelling probe's own loop, which does
      // `answer = JSON.stringify(rows)` on EVERY rep. It sits OUTSIDE the timed interval, so it
      // cannot inflate a reading directly — but 16,000 rows stringified 9 times per pass is GC
      // pressure the one-shape-per-process probe never generates, and it lands between the
      // measurements rather than inside them.
      if (process.env.STRINGIFY === '1') {
        JSON.stringify(rows);
      }
    }

    return Math.min(...reps.slice(3));
  };

  const forward = group.map(timeOne);
  const reverse: number[] = [];

  for (let i = group.length - 1; i >= 0; i -= 1) {
    reverse[i] = timeOne(group[i]);
  }

  console.log(`MULTI one process, min of both passes (PROPS=${RICH ? 'rich' : 'lean'}):`);

  for (const [i, name] of group.entries()) {
    console.log(
      `  ${name.padEnd(12)} ${Math.min(forward[i], reverse[i]).toFixed(4)} ms` +
        `   (fwd ${forward[i].toFixed(2)}  rev ${reverse[i].toFixed(2)})`,
    );
  }

  process.exit(0);
}

const series: number[] = [];
let rows = 0;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();
  const out = query(g, q, {});

  series.push(performance.now() - t0);
  rows = out.length;
}

const kept = series.slice(3).sort((a, b) => a - b);

console.log(
  `SHAPE=${SHAPE} IDX=${process.env.IDX ?? '0'} PROPS=${RICH ? 'rich' : 'lean'} LOAD=${NDJSON ? 'ndjson' : 'api'} E=${process.env.EDGES ?? '0'} rows=${rows} ` +
    `MEDIAN ${kept[Math.floor(kept.length / 2)].toFixed(4)} ms`,
);
console.log(`  series ${series.map((x) => x.toFixed(2)).join(' ')}`);
