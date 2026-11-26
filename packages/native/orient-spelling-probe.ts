/**
 * Does a TWO-HOP LIST cost the same written from either end? (item 2290)
 *
 * **IT DOES NOT, AND THE GAP IS ASYMPTOTIC** (item 2289): the authz question "which subjects can see
 * this object" is **O(results) written from the object and O(TENANT) written from the subject** — 0.69 ms
 * against 9.24 at 400,000 users, for the identical 2,000 rows, growing without bound in the population.
 *
 * **WHY THE EXISTING PROBES MISS IT.** `direction-spelling-probe.ts` compares `-[:T]->` against
 * `<-[:T]-` on a ONE-HOP COUNT over a UNIFORM fixture. This shape differs in all three respects, and each
 * one is load-bearing:
 *
 *   - **TWO hops**, so there is a middle vertex and therefore an orientation CHOICE to get wrong;
 *   - **a LIST**, not a count — a count has closed-form routes that hide the walk entirely;
 *   - **a SKEWED fixture**, one object against a whole tenant. On a uniform graph both ends are equally
 *     selective and the cliff CANNOT appear, however many spellings are compared.
 *
 * So this is a probe, not a test: time is the only signal, a threshold in CI would be flaky, and the
 * `spelling_probe` family's rule is that equivalent spellings must cost the same. **Read the PER-ARM
 * numbers, not just the group ratio** — the whole point is which arm is which.
 *
 *   cd packages/native && bun orient-spelling-probe.ts
 *   ORIENT_USERS=400000 bun orient-spelling-probe.ts     # the cliff grows with this
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.ORIENT_USERS ?? 200_000);
const MEMBERS = Number(process.env.ORIENT_MEMBERS ?? 2000);
const REPS = Number(process.env.ORIENT_REPS ?? 9);
const TOL = Number(process.env.ORIENT_TOL ?? 2);

const g = new Graph();

g.addVertex({ id: 'doc1', labels: ['Doc'], properties: { name: 'doc1' } });
g.addVertex({ id: 'team1', labels: ['Team'], properties: { name: 'team1' } });
g.addEdge({
  id: 'grant1',
  from: g.getVertexById('team1')!,
  to: g.getVertexById('doc1')!,
  labels: ['CAN_VIEW'],
  properties: {},
});

for (let i = 0; i < USERS; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}` } });
}

/*
 * MEMBERS is PINNED and independent of USERS, so the ANSWER is the same at every population size. That
 * is what makes a growing cost unambiguous: item 2289's first sweep tied members to users, and "flat per
 * result" then could not tell a per-user cost from a per-result one.
 */
for (let i = 0; i < MEMBERS; i += 1) {
  g.addEdge({
    id: `m${i}`,
    from: g.getVertexById(`u${i}`)!,
    to: g.getVertexById('team1')!,
    labels: ['MEMBER_OF'],
    properties: {},
  });
}

const GROUP: readonly (readonly [string, string])[] = [
  [
    'subject-first (the natural spelling)',
    'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $doc RETURN u.name AS n',
  ],
  [
    'object-first (the mirror)',
    'MATCH (d:Doc)<-[:CAN_VIEW]-(t:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $doc RETURN u.name AS n',
  ],
  [
    'subject-first, INLINE far predicate',
    'MATCH (u:User)-[:MEMBER_OF]->(t:Team)-[:CAN_VIEW]->(d:Doc {name: $doc}) RETURN u.name AS n',
  ],
  [
    'object-first, hops reordered',
    'MATCH (t:Team)-[:CAN_VIEW]->(d:Doc) MATCH (u:User)-[:MEMBER_OF]->(t) WHERE d.name = $doc RETURN u.name AS n',
  ],
];

/*
 * **TWO REFERENCES, AND THE FIRST IS NOT A CONTROL — I MISLABELLED IT AND IT TURNED OUT MORE USEFUL.**
 *
 * `SCAN_REF` looks for a user name that does not exist, so it is a FULL population scan returning nothing.
 * At 400,000 users it reads 12.42 ms where the subject-first arm reads 14.75 — which DECOMPOSES the slow
 * arm rather than controlling for it: most of that spelling IS this scan. A control must be insensitive to
 * the effect, and a scan is precisely what the effect IS.
 *
 * `CONTROL` is the real one: one selective lookup no orientation decision can reach. If IT moves between
 * runs, the instrument is noisy and the group's spread means nothing.
 */
const SCAN_REF = 'MATCH (u:User) WHERE u.name = $doc RETURN u.name AS n';
const CONTROL = 'MATCH (d:Doc) WHERE d.name = $doc RETURN d.name AS n';

/** Median after dropping three reps as warm-up — item 579's instrument, and item 2284's lesson. */
const measure = (text: string): [number, number] => {
  const ts: number[] = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    rows = query(g, text, { doc: 'doc1' }).length;
    ts.push(performance.now() - t);
  }

  const kept = ts.slice(3).sort((a, b) => a - b);

  return [kept[Math.floor(kept.length / 2)] ?? 0, rows];
};

console.log(`  USERS=${USERS} MEMBERS=${MEMBERS} REPS=${REPS} (median of the last ${REPS - 3})`);

const results: [string, number, number][] = [];

for (const [label, text] of GROUP) {
  const [ms, rows] = measure(text);

  results.push([label, ms, rows]);
  console.log(`    ${label.padEnd(38)} ${ms.toFixed(2).padStart(9)} ms   rows=${rows}`);
}

const [scanMs, scanRows] = measure(SCAN_REF);
const [ctrlMs, ctrlRows] = measure(CONTROL);

console.log(
  `    ${'(scan ref: whole population)'.padEnd(38)} ${scanMs.toFixed(2).padStart(9)} ms   rows=${scanRows}`,
);
console.log(
  `    ${'(control: one selective lookup)'.padEnd(38)} ${ctrlMs.toFixed(2).padStart(9)} ms   rows=${ctrlRows}`,
);

/* An answer difference means the spellings are NOT equivalent and no timing comparison is valid. */
const answers = new Set(results.map(([, , rows]) => rows));

if (answers.size !== 1) {
  throw new Error(`spellings disagree on the ANSWER: ${[...answers].join(' vs ')}`);
}

const times = results.map(([, ms]) => ms);
const spread = Math.max(...times) / Math.min(...times);

console.log(
  `\n  spread ${spread.toFixed(2)}x across ${results.length} spellings of one question (tolerance ${TOL}x)`,
);

console.log(
  `  the slow arm is ${(Math.max(...times) / Math.max(scanMs, 0.001)).toFixed(2)}x the whole-population scan — near 1x, that scan IS the cost`,
);

if (spread > TOL) {
  const slowest = results.reduce((a, b) => (a[1] > b[1] ? a : b));
  const fastest = results.reduce((a, b) => (a[1] < b[1] ? a : b));

  console.log(
    `  FLAGGED: "${slowest[0]}" is ${spread.toFixed(2)}x "${fastest[0]}" — and this gap GROWS with ORIENT_USERS,`,
  );
  console.log('           so it is asymptotic, not a constant factor. See item 2289.');
}
