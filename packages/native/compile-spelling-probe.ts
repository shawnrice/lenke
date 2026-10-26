/**
 * Item 905: equivalent spellings must cost the same TO PLAN, not just to run.
 *
 * `bun run spelling` checks that equivalent query spellings cost the same at RUNTIME, and it has
 * earned itself twice (a 4x clause-vs-inline gap on a one-hop count at item 125, a 2.9x three-way
 * node-count gap at 126). It does not look at COMPILE time at all, and nothing else did either —
 * item 883's figure for the TS planner (~1.02 us) was measured on a single INSERT.
 *
 * Measured per shape, the planner is not one number:
 *
 *     MATCH (n) RETURN n        18 chars   parse 1.162 us   compile 2.653   <- compile is 70%
 *     the INSERT                47         parse 2.184      compile 0.531   <- 20%
 *     the big MATCH            158         parse 7.030      compile 9.500   <- 57%
 *
 * So a MATCH plans for 18x what a longer INSERT does, and 883's single-shape figure understated the
 * MATCH case by that much. Shape, not size: the simplest possible MATCH plans in 2.65 us.
 *
 * AND THE SPELLINGS DISAGREE. Against a shared no-predicate control, three order-alternated rounds:
 *
 *     control  (no predicate)           2.583 us
 *     inline   {k: 1}                   2.942      +0.359
 *     clause   WHERE n.k = 1            4.568      +1.985   = 5.53x the inline
 *     inline   {k: 1, j: 2}             3.594      +1.011
 *     clause   WHERE n.k = 1 AND n.j=2  6.337      +3.754   = 3.71x the inline
 *
 * Disjoint: the clause arm's fastest round (4.57) is above the inline arm's slowest (3.30). One
 * question, two spellings, 3.7-5.5x apart in planning cost — the defect class this engine is named
 * for, in a dimension its own probe does not cover. Item 231 closed the RUNTIME gap for this exact
 * pair ("the clause spelling of a filtered projection cost 9.64 ms against the inline spelling's
 * 6.78"); the compile gap was never looked at.
 *
 * It matters because of the cache. Item 883 measured a parse+plan MISS at ~5.9 us more than a hit,
 * and ~2 us of that — a third — is the clause spelling's extra planning for a single predicate.
 * Dynamically-built query text misses every time.
 *
 * WHY THIS IS A PROBE AND NOT A TEST: like `spelling-probe.ts`, time is the only signal, so a
 * threshold in CI would be flaky. Run it when touching `pushWhereIntoNode`, `directEqProps` or the
 * clause compiler, and add any new spelling pair here.
 */
import { compile, parse } from '@lenke/gql';

const REPS = 14;
const DROP = 3;
const ROUNDS = 3;
const OPS = Number(process.env.A_OPS ?? 20_000);

/**
 * Each group is a set of spellings that must cost the same to PLAN, with the first entry acting as
 * the group's control where one applies.
 */
const GROUPS: ReadonlyArray<{ name: string; cases: ReadonlyArray<readonly [string, string]> }> = [
  {
    name: 'one predicate on one node',
    cases: [
      ['control (none)', 'MATCH (n:L) RETURN n'],
      ['inline {k:1}', 'MATCH (n:L {k: 1}) RETURN n'],
      ['clause WHERE', 'MATCH (n:L) WHERE n.k = 1 RETURN n'],
      ['inline WHERE', 'MATCH (n:L WHERE n.k = 1) RETURN n'],
    ],
  },
  {
    name: 'two predicates on one node',
    cases: [
      ['control (none)', 'MATCH (n:L) RETURN n'],
      ['inline 2 props', 'MATCH (n:L {k: 1, j: 2}) RETURN n'],
      ['clause 2 conjuncts', 'MATCH (n:L) WHERE n.k = 1 AND n.j = 2 RETURN n'],
    ],
  },
  {
    // ITEM 907: where the planner's bulk is. Each rung adds ONE stage, so the differences are the
    // stages. The dominant single cost is the FIRST node pattern, and a second one costs half as
    // much — which points at per-query setup rather than per-pattern work.
    name: 'inside the planner, stage by stage',
    cases: [
      ['RETURN 1', 'RETURN 1'],
      ['RETURN 1 + 2', 'RETURN 1 + 2'],
      ['MATCH (n) RETURN 1', 'MATCH (n) RETURN 1'],
      ['MATCH (n) RETURN n', 'MATCH (n) RETURN n'],
      ['MATCH (n) RETURN n.k', 'MATCH (n) RETURN n.k'],
      ['two MATCH clauses', 'MATCH (n) MATCH (m) RETURN 1'],
    ],
  },
  {
    // ITEM 909: a SCOPE-SIZE scale. `checkLinearScope`'s match arm used to copy the whole visible
    // scope per MATCH clause, so the wasted work was O(clauses^2) — invisible at the 1-3 variables
    // every other group here has, and 1.48x at 48 clauses. This group exists so that the next
    // change to the scope checker is measured against a fixture whose scope is big enough to see
    // it: item 909's first A/B used a 3-variable scope and read 1.01x, which is the repo's own
    // "match the fixture to the claim" rule catching a null that was the fixture's fault.
    name: 'scope SIZE (one MATCH clause per variable)',
    cases: [
      ['chain 1', 'MATCH (v0) RETURN 1'],
      ['chain 8', `${Array.from({ length: 8 }, (_, i) => `MATCH (v${i})`).join(' ')} RETURN 1`],
      ['chain 24', `${Array.from({ length: 24 }, (_, i) => `MATCH (v${i})`).join(' ')} RETURN 1`],
      ['chain 48', `${Array.from({ length: 48 }, (_, i) => `MATCH (v${i})`).join(' ')} RETURN 1`],
    ],
  },
  {
    name: 'the planner by SHAPE (not a spelling group — a scale)',
    cases: [
      ['no pattern', 'RETURN 1'],
      ['1 bare node', 'MATCH (n) RETURN n'],
      ['2 nodes + rel', 'MATCH (a:L)-[:R]->(b:L) RETURN a'],
      [
        'big',
        'MATCH (a:L)-[:R]->(b:L) WHERE a.k = 1 AND b.j <> 2 AND a.m >= 3 ' +
          'RETURN a.n AS s ORDER BY s DESC LIMIT 10',
      ],
    ],
  },
];

/** Plan `text` OPS times from FRESH ASTs, so no cache can serve any of them. */
const planUs = (text: string): number => {
  // Pre-parsed, so the measurement is planning only and the parser is not in it.
  const asts = Array.from({ length: OPS }, () => parse(text));
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    let sink = 0;
    const t0 = performance.now();

    for (let i = 0; i < OPS; i += 1) {
      sink += compile(asts[i] as never) === undefined ? 0 : 1;
    }

    series.push(performance.now() - t0);

    if (sink !== OPS) {
      throw new Error(`compiled ${sink} of ${OPS} — the arm did not do what it claims`);
    }
  }

  // Item 884's estimator rule for this path: drop the visible JIT warm-up, take the median.
  const plateau = series.slice(DROP).sort((a, b) => a - b);

  return (plateau[Math.floor(plateau.length / 2)] * 1000) / OPS;
};

const best: Record<string, number[]> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  for (const group of GROUPS) {
    const order = round % 2 === 1 ? [...group.cases].reverse() : group.cases;

    for (const [label, text] of order) {
      const key = `${group.name}::${label}`;

      (best[key] ??= []).push(planUs(text));
    }
  }
}

console.log(
  `# item 905 — PLANNING cost by spelling (median of ${REPS - DROP}, min of ${ROUNDS} rounds)\n`,
);

for (const group of GROUPS) {
  console.log(`${group.name}:`);

  const ms = (label: string): number => Math.min(...best[`${group.name}::${label}`]);
  const [first] = group.cases;
  const hasControl = first[0].startsWith('control');
  const base = hasControl ? ms(group.cases[0][0]) : 0;

  for (const [label] of group.cases) {
    const v = ms(label);
    const delta = hasControl && v !== base ? ` (+${(v - base).toFixed(3)} over control)` : '';

    console.log(
      `  ${label.padEnd(20)} ${v.toFixed(3).padStart(8)} us${delta.padEnd(26)} rounds: ${best[`${group.name}::${label}`].map((x) => x.toFixed(2)).join(' ')}`,
    );
  }

  console.log('');
}
