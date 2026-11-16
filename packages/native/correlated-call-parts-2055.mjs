/*
 * Item 2055 — SPLITTING THE CORRELATED `CALL`'s PER-ROW COST BY SCALING THE SIDES INDEPENDENTLY.
 *
 * Item 2054 put ~30% of `callscoped` in per-row plan dispatch and 2.7% in `buildGroups`, and asked
 * whether a single-group `count(*)` could skip the grouping machinery. ⚠️ **A PROFILE SHARE CANNOT
 * ANSWER THAT**, and the sibling item says so in its own words: for the UNCORRELATED form the same
 * frames appeared at small shares, and *"a body run ONCE shows exactly those frames too… a share is
 * not a count"* — the mechanism was only settled by `uncorrelated-call-reuse-probe.mjs`, which scales
 * the outer row count and the body cost independently. This is that probe's correlated twin.
 *
 * 🔑 **THE ARMS ARE CHOSEN SO EACH DIFFERENCE ISOLATES ONE TERM:**
 *
 *   outer x1000 with the SAME body      -> is the per-row term linear in outer rows?
 *   same outer with a TRIVIAL body      -> how much is plumbing rather than the body's work?
 *   `RETURN 1` vs `RETURN count(*)`     -> **the grouping machinery alone**, since the two differ in
 *                                          nothing else and both yield exactly one nested row
 *   no CALL at all                      -> the outer pattern's own cost
 *
 * ⚠️ THE ANSWERS DIFFER BETWEEN ARMS BY DESIGN — these are not equivalent spellings, so each arm's
 * answer is PRINTED rather than asserted equal. Item 2054 withdrew a ratio built from two shapes whose
 * `count(*)` happened to agree; the lesson is to show the answers, not to hide them behind a check
 * that cannot fail.
 *
 *     bun correlated-call-parts-2055.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

for (let e = 0; e < NODES; e += 1) {
  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${e}`),
    to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

const HOP = 'MATCH (n)-[:E]->(x) RETURN count(*) AS d';
const CASES = {
  'outer=ALL   body=hop': `MATCH (n:P) CALL (n) { ${HOP} } RETURN count(*) AS c`,
  'outer=1/97  body=hop': `MATCH (n:P) WHERE n.k = 5 CALL (n) { ${HOP} } RETURN count(*) AS c`,
  'outer=1     body=hop': `MATCH (n:P) WHERE n.n = 12345 CALL (n) { ${HOP} } RETURN count(*) AS c`,
  // The plumbing arm: scope setup per outer row, no graph work in the body at all.
  'outer=ALL   body=RETURN 1': 'MATCH (n:P) CALL (n) { RETURN 1 AS d } RETURN count(*) AS c',
  // The SAME trivial body plus an aggregate — the difference is the grouping machinery alone.
  'outer=ALL   body=count(*)': 'MATCH (n:P) CALL (n) { RETURN count(*) AS d } RETURN count(*) AS c',
  'outer=ALL   no call': 'MATCH (n:P) RETURN count(*) AS c',
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[s.length >> 1];
};

console.log(
  `\n# correlated-call-parts NODES=${NODES} reps=${REPS}; ${g.vertexCount} vertices, ${g.edgeCount} edges\n`,
);

const ms = {};

for (const [name, q] of Object.entries(CASES)) {
  const series = [];
  let answer;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = [...query(g, q)];

    series.push(performance.now() - t0);
    answer = rows.length === 1 ? Number(rows[0].c) : rows.length;
  }

  // Median of the plateau; the first reps are V8 tiering up (items 2043-2045).
  const m = median(series.slice(2));

  ms[name] = m;
  console.log(
    `  ${name.padEnd(26)} ${m.toFixed(2).padStart(9)} ms   answer ${String(answer).padStart(7)}`,
  );
}

/*
 * ⚠️⚠️ **THE DECOMPOSITION THIS PROBE WAS BUILT FOR DOES NOT WORK, and the numbers say so loudly: a
 * "trivial" body is DEARER than the hop body**, which makes any subtraction meaningless (negative
 * body work, a 146% plumbing share). Two confounds, both fatal:
 *
 *   1. **THE BODY'S ROUTE CHANGES WITH THE BODY.** `MATCH (n)-[:E]->(x) RETURN count(*)` is served by
 *      the count rung (item 1661) off a bucket size; `RETURN count(*)` with no pattern has no rung and
 *      takes the general path. So body cost is not additive with plumbing — picking a "cheaper" body
 *      picked a slower ROUTE.
 *   2. **THE LOW-OUTER ARMS ARE DOMINATED BY THE OUTER SCAN.** `WHERE n.n = 12345` is unindexed here,
 *      so finding one row still scans 200,000 vertices: 8.16 ms for ONE outer row is that scan, not
 *      the body.
 *
 * This is the same error items 2053 and 2054 withdrew ratios for — arms assumed to differ in one term
 * while differing in route — arrived at from a new direction. **So only the one CONTROLLED comparison
 * is reported: same outer rows, same outer scan, body varying.**
 */
const perRow = (m) => (m * 1000) / NODES;

console.log(
  `\n  CONTROLLED (identical 200k outer rows and outer scan, only the body differs):` +
    `\n    body = MATCH (n)-[:E]->(x) RETURN count(*)   ${perRow(ms['outer=ALL   body=hop']).toFixed(3)} us a row   <- hits the count rung` +
    `\n    body = RETURN 1                             ${perRow(ms['outer=ALL   body=RETURN 1']).toFixed(3)} us a row` +
    `\n    body = RETURN count(*)                      ${perRow(ms['outer=ALL   body=count(*)']).toFixed(3)} us a row   <- no rung: the GENERAL per-row path` +
    `\n\n  the pattern-free aggregate body is ${(ms['outer=ALL   body=count(*)'] / ms['outer=ALL   body=hop']).toFixed(2)}x the HOP body — the simpler query is dearer` +
    `\n\n  ⚠️ NOT REPORTED: any plumbing-minus-body subtraction. See the comment above — the arms do not` +
    `\n     share a route, so the difference is not a decomposition.\n`,
);
