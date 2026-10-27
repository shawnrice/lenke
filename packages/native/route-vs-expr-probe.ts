/**
 * Item 951: is the TS nested read's ~50 ns/row the FIELD STEP, or a specialised ROUTE not firing?
 *
 * Item 899 measured `p.meta.other = 'NYC'` at 3.4x `p.tier = 'NYC'` and attributed the gap to
 * "expression plumbing". Item 950 built the fusion that attribution implies — removing one closure
 * invocation from the field arm — and got a NULL, then noticed the confound: `compileLinear` ends
 * in nineteen independent compile-time detectors, and those two spellings were never shown to take
 * the same route. A detector that recognises `count(*)` under a bare-prop equality would make the
 * whole 3.4x a route difference, with the expression tree merely what disqualifies the nested one.
 *
 * THE FOUR ARMS, and what each one can and cannot tell you. All four return the SAME count over the
 * SAME rows, so downstream work is identical and the ratio is the predicate alone.
 *
 *   A  `p.tier = 'NYC'`        bare prop, prop on the LEFT      the baseline
 *   B  `'NYC' = p.tier`        bare prop, prop on the RIGHT     ZERO extra work; route only
 *   C  `p.lst[0] = 'NYC'`      list subscript                   one ARRAY read, not a bare prop
 *   D  `p.meta.other = 'NYC'`  field step                       one MAP read, not a bare prop
 *
 * B is the arm that makes this a diagnosis rather than another ladder. It reads the same property
 * by the same path and allocates nothing extra, so if B costs what A costs the detector is
 * spelling-symmetric, and if B costs what C and D cost then the surface spelling alone decides the
 * route — which would be exactly the equivalent-spelling bug class this repo documents, found by
 * timing rather than by a plan dump because the TS engine has no plan to dump.
 *
 * C against D separates "not a bare prop" from "a Map read is dear". A list subscript is an array
 * index, far cheaper than `LenkeRecord.get` (item 899 measured the subclass read at 17.5 ns and a
 * plain object at 3.4 ns). If C and D cost the same, the read is not what is being paid for.
 *
 * ONE PROCESS, ONE GRAPH — item 897's rule, and item 762's: a change that redistributes call sites
 * flatters itself across processes, so every arm shares one heap and one set of inline caches.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 9;
const ROUNDS = 3;
const CITIES = ['NYC', 'LDN', 'TYO', 'BER'];
const MATCHING = Math.floor(N / CITIES.length);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  const city = CITIES[i % CITIES.length];

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { tier: city, lst: [city, city], meta: { other: city, pad: city } },
  });
}

// [label, query, expected count, one line on what the arm isolates]
const CASES: ReadonlyArray<readonly [string, string, number, string]> = [
  [
    'A bare prop LEFT',
    "MATCH (p:P) WHERE p.tier = 'NYC' RETURN count(*) AS c",
    MATCHING,
    'baseline',
  ],
  [
    'B bare prop RIGHT',
    "MATCH (p:P) WHERE 'NYC' = p.tier RETURN count(*) AS c",
    MATCHING,
    'same reads, route only',
  ],
  [
    'C list subscript',
    "MATCH (p:P) WHERE p.lst[0] = 'NYC' RETURN count(*) AS c",
    MATCHING,
    'one ARRAY read',
  ],
  [
    'D field step',
    "MATCH (p:P) WHERE p.meta.other = 'NYC' RETURN count(*) AS c",
    MATCHING,
    'one MAP read',
  ],
];

const best: Record<string, number[]> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q, expect] of order) {
    const series: number[] = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);

      const c = Number((rows[0] as Record<string, unknown>)?.c ?? -1);

      // A ratio between arms answering different questions is meaningless, so the count is
      // asserted per rep rather than once: all four arms must select the identical rows.
      if (c !== expect) {
        throw new Error(`FIXTURE/QUERY WRONG for ${name}: count=${c}, expected ${expect}`);
      }
    }

    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 951 — route or expression? (N=${N}, min of ${REPS}, ${ROUNDS} alternated rounds)`,
);
console.log('# All four arms return the same count over the same rows.\n');

const baseline = Math.min(...(best['A bare prop LEFT'] ?? [0]));

for (const [name, , , note] of CASES) {
  const rounds = best[name] ?? [];
  const ms = Math.min(...rounds);
  const ns = (ms * 1e6) / N;
  const rel = ms / baseline;

  console.log(
    `  ${name.padEnd(20)} ${ms.toFixed(2).padStart(7)} ms  ${ns.toFixed(1).padStart(5)} ns/row  ` +
      `${rel.toFixed(2)}x A   rounds: ${rounds.map((x) => x.toFixed(2)).join(' ')}   (${note})`,
  );
}

console.log('\nREADING IT:');
console.log('  B ~ A          -> the detector is spelling-symmetric; the gap is the EXPRESSION');
console.log('  B ~ C,D >> A   -> the surface spelling picks the route; the gap is the ROUTE');
console.log(
  '  C ~ D          -> the READ is not what is paid for (an array index is not a Map get)',
);
console.log('  C << D         -> the field step really is dearer than a non-bare-prop expression');
