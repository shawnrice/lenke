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
 * THE NINE ARMS, and what each one can and cannot tell you. All nine return the SAME count over the
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
const ROUNDS = 5;
const CITIES = ['NYC', 'LDN', 'TYO', 'BER'];
const MATCHING = Math.floor(N / CITIES.length);

const g = new Graph();

/**
 * FOUR shared nested containers, one per city, reused by every vertex (item 953).
 *
 * `meta`/`lst` give each vertex its OWN nested object, so indexing into one chases a pointer to a
 * cold heap container — 200,000 distinct ones. `shared`/`slst` carry the identical values through
 * just FOUR, which stay hot. The predicate still selects exactly the same rows, so a collapse in
 * cost is memory locality and nothing else.
 */
const SHARED = CITIES.map((city) => ({ other: city, pad: city }));
const SLST = CITIES.map((city) => [city, city]);

for (let i = 0; i < N; i += 1) {
  const city = CITIES[i % CITIES.length];

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    // `q` is 0..3 alongside `tier`, so `q = 0` and `q <= 0` select exactly the rows `tier = 'NYC'`
    // does — which makes the eqProps and cmpProps arms row-matched with the baseline.
    properties: {
      tier: city,
      q: i % CITIES.length,
      lst: [city, city],
      meta: { other: city, pad: city },
      slst: SLST[i % CITIES.length],
      shared: SHARED[i % CITIES.length],
    },
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
  // D' is D's ROW-MATCHED TWIN and the instrument that prices the lift (item 954). A STRING index
  // on a record is field access, so `p.meta['other']` reads the same cell as `p.meta.other` and
  // returns the same rows — but it parses as `kind: 'index'`, which `fieldChain` does not accept,
  // so it CANNOT lift. D minus D' is therefore the whole value of lifting, with the read, the
  // container, the locality and the answer all held fixed. Nothing else in this file isolates it.
  [
    "D' field UNLIFTED",
    "MATCH (p:P) WHERE p.meta['other'] = 'NYC' RETURN count(*) AS c",
    MATCHING,
    'same cell, generic path',
  ],
  // E and F are the pair that isolates the COMPARATOR from the read (item 952). Same key, same
  // rows, same lifted-and-element-direct route — the only difference is which list carries it:
  // `eqProps` settles with `structuralEq`, `cmpProps` with `compareTruth(op, COMPARE[op], ..)`,
  // and `pathProps` (arm D) uses `compareTruth` too. If F is cheap and E is dear, D's residual is
  // the comparator and not the path walk.
  ['E cmpProps num', 'MATCH (p:P) WHERE p.q <= 0 RETURN count(*) AS c', MATCHING, 'compareTruth'],
  ['F eqProps num', 'MATCH (p:P) WHERE p.q = 0 RETURN count(*) AS c', MATCHING, 'structuralEq'],
  // G and H are C and D with the nested container SHARED four ways instead of one per vertex
  // (item 953). Same route, same code path, same rows, same reads — only the locality differs.
  [
    'G field SHARED',
    "MATCH (p:P) WHERE p.shared.other = 'NYC' RETURN count(*) AS c",
    MATCHING,
    '4 hot records',
  ],
  [
    'H subscript SHARED',
    "MATCH (p:P) WHERE p.slst[0] = 'NYC' RETURN count(*) AS c",
    MATCHING,
    '4 hot arrays',
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
      // asserted per rep rather than once: every arm must select the identical rows.
      if (c !== expect) {
        throw new Error(`FIXTURE/QUERY WRONG for ${name}: count=${c}, expected ${expect}`);
      }
    }

    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 951 — route or expression? (N=${N}, min of ${REPS}, MEDIAN of ${ROUNDS} alternated rounds)`,
);
console.log('# All nine arms return the same count over the same rows.\n');

/**
 * MEDIAN of the rounds, not the min (item 953).
 *
 * `min` picked 16.93 for the field arm whose other two rounds read 20.38 and 20.30, and then
 * reported the IDENTICAL shared-container arm as 1.21x slower — an effect that was entirely the
 * estimator. The TS per-row path emits a rare fast rep and `min` latches onto it; the repo's own
 * rule is median-of-rounds with the warm-up dropped. Every round is still printed, so a reader can
 * see the spread rather than take this on trust.
 */
const medianOf = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[(s.length - 1) >> 1];
};

const baseline = medianOf(best['A bare prop LEFT'] ?? [0]);

for (const [name, , , note] of CASES) {
  const rounds = best[name] ?? [];
  const ms = medianOf(rounds);
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
