/**
 * Which spellings of a GROUPED COUNT reach a fast rung, and which fall to the general path?
 * (item 1581)
 *
 * The cross-surface probe found `MATCH (n) LET grp = n.k RETURN count(*) GROUP BY grp` at **27x**
 * its Gremlin twin `V().groupCount({by:'k'})` — 21 ms against 0.78. `detectGroupedNodeAggregate`
 * and the `detectGroupedNodeCount` tally both gate on `clauses.length !== 2`, so a `LET` clause in
 * front of the `RETURN` declines every rung by arity alone, before anything looks at the grouping.
 *
 * That is a SPELLING question, not a cost question, so it needs the spellings side by side. Each is
 * a separate PROCESS (`ARM=<n>`): items 1578/1579 both produced an impossible in-process reading
 * when arms shared a call site, and a rung-selection change is exactly the shape item 762 warned
 * about — routing some shapes elsewhere cleans the inline caches of the site left behind.
 *
 *     for a in let2 alias1 alias2 nokey; do ARM=$a node group-count-spelling-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50_000);
const REPS = Number(process.env.REPS ?? 9);
const ARM = process.env.ARM ?? 'let2';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

/**
 * All four ask "how many of each `k`", over the same 97 groups.
 *
 * ⚠️ They are NOT all the same ROW SHAPE, and that is the point rather than a flaw in the
 * comparison: `alias2` projects the key beside the count, which is what the two-item rungs require
 * (`proj.items.length < 2` declines). So the question this probe answers is not only "is one
 * spelling slower" but "is the fast shape REACHABLE at all for a one-column grouped count".
 */
const ARMS = {
  /** What the cross-surface probe asked. Three clauses, so every rung declines on arity. */
  let2: 'MATCH (n) LET grp = n.k RETURN count(*) AS c GROUP BY grp',
  /** One column, grouping by a projected alias. Two clauses, but one projection item. */
  alias1: 'MATCH (n) RETURN count(*) AS c GROUP BY n.k',
  /**
   * Two columns, two clauses — the shape the tally and the aggregate rung are written for.
   *
   * ⚠️ `GROUP BY key`, naming the OUTPUT ALIAS, is a syntax error here: `variable \`key\` is not
   * defined`. GROUP BY is evaluated before the projection, so it cannot see an alias the
   * projection introduces, and it must repeat the expression. That is correct and it is also why
   * the fast shape is less reachable than it looks.
   */
  alias2: 'MATCH (n) RETURN n.k AS key, count(*) AS c GROUP BY n.k',
  /** The control: an UNGROUPED count over the same scan, which has its own long-closed rung. */
  nokey: 'MATCH (n) RETURN count(*) AS c',
  /**
   * THE GENERAL-PATH CONTROL, measured on the SAME BUILD as the fast arms.
   *
   * Item 1582 admits the one-column grouped count to the tally but declines it when an
   * `ORDER BY` is present, because the only resolvable target is the count column and
   * `colSortsOf` is written around a projected KEY column this form does not have. So this arm
   * asks the same question, over the same scan, and still goes through the general path — which
   * is what makes it a scale check that does not depend on comparing two builds.
   */
  ord1: 'MATCH (n) RETURN count(*) AS c GROUP BY n.k ORDER BY c',
};

const text = ARMS[ARM];

if (text === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const run = () => query(g, text);
const rows = run();
const s = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  run();
  s.push(performance.now() - t0);
}

// Drop three as warm-up, take the MEDIAN of the rest — `ts-spelling-probe`'s estimator, because
// `min` on this engine reports a rare fast rep off the general scalar path.
const kept = s.slice(3).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    arm: ARM,
    gql: text,
    groups: Array.isArray(rows) ? rows.length : null,
    ms: Number((kept[Math.floor(kept.length / 2)] ?? 0).toFixed(3)),
    series: s.map((x) => Number(x.toFixed(1))),
  }),
);
