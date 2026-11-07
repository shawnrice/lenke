/**
 * WHAT DOES A CORRELATED `CALL { … }` SUBQUERY COST PER OUTER ROW? (item 1653)
 *
 * ⚠️ NOT TO BE CONFUSED WITH `gql-call-overhead-probe.mjs`, which prices what a warm `query()` call
 * costs before it touches the graph. This one prices the ISO-GQL **CALL STATEMENT** — the per-row
 * subquery — which nothing has measured on the TS side.
 *
 * ⚠️ WHY IT EXISTS. A mechanical screen of ten unprofiled GQL shapes (item 1653) put `callinline` at
 * **21.7 ms per call over 20,000 outer rows — 1085 ns/row**, where the native engine's own operator
 * table prices `CallInline` (correlated) at **8.33 ns/row** (item 623) and the inline spelling of the
 * same question costs ~12 ns/row here. The profile is all general pattern machinery —
 * `withBinding` 14.2%, `matchPattern` 12.9%, `walkSegments` 12.0%, `hoistedMatch` 5.1%, and
 * `seedVertices` / `candidateVertices` at 2.6% each even though the inner `MATCH` starts from a
 * BOUND variable and has nothing to seed.
 *
 * ⚠️ THE PAIR IS AN EQUIVALENT SPELLING, WHICH IS THE WHOLE POINT. `sumcall` and `inline` compute
 * the SAME TOTAL (every edge, counted once) by two routes, and the probe asserts they agree before
 * reporting any time — so a gap here is CLAUDE.md's opening defect class rather than two different
 * questions being compared (item 1465).
 *
 *     node gql-call-subquery-floor.mjs            # every arm
 *     ARM=sumcall N=20000 node gql-call-subquery-floor.mjs
 *
 * ONE ARM PER PROCESS unless ARM is unset (item 762); the all-arms mode is for the answer assertion
 * and a first look, and its numbers are not to be quoted against another file's (item 1640).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);
const { ARM } = process.env;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } });
}

// ⚠️ A BRANCHING fixture: `(a*k + b) % N` alone is invariant under `k -> k + N`, which would give
// every vertex FANOUT parallel edges to ONE target and make a hop count `F · N` by construction
// (items 702/1516/1518). The repeat-index term breaks that.
let edges = 0;

for (let k = 0; k < N * FANOUT; k += 1) {
  const from = (k * 7919) % N;
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`v${from}`),
    to: g.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

{
  const targets = new Set();

  for (let k = 0; k < N * FANOUT; k += 1) {
    targets.add(((k % N) * 104_729 + Math.floor(k / N) * 977) % N);
  }

  if (targets.size < N * 0.5) {
    throw new Error(`degenerate fixture: ${targets.size} distinct targets for ${N} vertices`);
  }
}

const ARMS = {
  /**
   * ⚠️ NOT A VALID FLOOR FOR THE CALL ARMS, and item 1654 found that out by profiling one. A bare
   * `count(*)` is answered by a closed-form rung WITHOUT materialising a binding per vertex, while
   * every CALL arm must materialise 20,000 of them for the clause to run against. Comparing them
   * gives a ratio between two different amounts of work (item 1465). Kept, labelled, as the
   * rung's own number.
   */
  outer: 'MATCH (n:P) RETURN count(*) AS t',
  /**
   * ⚠️ THE REAL FLOOR FOR THE CALL ARMS: the same per-row binding and the same outer aggregate,
   * with the CALL clause replaced by the cheapest clause that also binds a name. `calltrivial`
   * minus THIS is the inline-CALL clause's own cost.
   */
  letrow: 'MATCH (n:P) LET c = 1 RETURN sum(c) AS t',
  /** The outer scan forced to materialise, with no extra clause at all. */
  projrow: 'MATCH (n:P) RETURN sum(n.k) AS t',
  /**
   * ⚠️ THE CORRELATED FORM IS `CALL (n) { … }` — ISO-GQL, not Cypher. The scope list is what
   * imports an outer name; without it the body's `n` is a FRESH variable. CLAUDE.md says this has
   * been gotten wrong many times, and this probe's own answer assertion caught me doing it: the
   * scope-less spelling answered 799,800,000 where the correlated one answers 39,990.
   */
  correlated:
    'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN sum(c) AS t',
  /** ⚠️ THE EQUIVALENT SPELLING of `correlated`: the same total by one pattern. */
  inline: 'MATCH (n:P)-[:E]->(x) RETURN count(*) AS t',
  /**
   * ⚠️ THE SAME BODY WITH NO SCOPE, so it is UNCORRELATED: its answer cannot depend on the outer
   * row, yet the engine re-runs it for every one. `memoizeIfUncorrelated` exists for exactly this
   * and reaches only EXPRESSION subqueries (`exists`/`countSubquery`/`valueSubquery`) — the CALL
   * STATEMENT is a clause and never sees it. This arm is the ceiling of extending it.
   */
  uncorrelated:
    'MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t',
  /** The uncorrelated body ALONE, run once — the floor the memoised form would land on. */
  bodyonce: 'MATCH (n)-[:E]->(x) RETURN count(*) AS t',
  /** A per-row subquery that touches NO edge, so the clause cost is separated from the body. */
  calltrivial: 'MATCH (n:P) CALL { RETURN 1 AS c } RETURN sum(c) AS t',
  /**
   * ⚠️ THE SAME TRIVIAL BODY, SCOPED. `calltrivial` costs 534.8 ns an outer row doing NOTHING
   * while `correlated` costs 67.5 doing a real hop — so the two CALL forms do not share a path.
   * This arm isolates that: identical body, the only difference being the scope list.
   */
  calltrivialscoped: 'MATCH (n:P) CALL (n) { RETURN 1 AS c } RETURN sum(c) AS t',

  /**
   * ⚠️ THE ARMS BELOW EXIST BECAUSE `correlated` IS NOT A VALID FLOOR EITHER, and the reason is the
   * same one item 1654 found for `outer` — one level further down. Profiling `correlated` shows
   * **`bucketSize` at 37.9% self time**: its body's `MATCH … RETURN count(*)` is answered by a
   * CLOSED-FORM COUNT RUNG per outer row, so the body never materialises a nested row at all. The
   * `inline` arm above is the same trap a third time — it reads 0.1 ns/row, which is a rung, not a
   * hop. So the 69.5-vs-825 gap between `correlated` and `calltrivialscoped` is NOT "a real body is
   * cheaper than a trivial one"; it is a rung against a materialising path.
   *
   * Each arm below is paired with an `inline*` equivalent spelling where **BOTH SIDES MATERIALISE**,
   * which is what makes the ratio a budget rather than a ratio between two amounts of work.
   */

  /**
   * The same hop as `correlated` with the count rung DENIED — `sum(1)` per matched row is the same
   * number by a path that must produce the rows. Pairs with `inlinesumrow`.
   */
  callsumrow: 'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN sum(1) AS c } RETURN sum(c) AS t',
  inlinesumrow: 'MATCH (n:P)-[:E]->(x) RETURN sum(1) AS t',

  /**
   * A body that emits ONE NESTED ROW PER EDGE rather than one aggregate per outer row, so the
   * `nested.map` merge runs once per edge and the outer binding is copied that many times. This is
   * the shape a real correlated CALL is written in. Pairs with `inlineprojx`.
   */
  callprojx: 'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN x.k AS c } RETURN sum(c) AS t',
  inlineprojx: 'MATCH (n:P)-[:E]->(x) RETURN sum(x.k) AS t',

  /**
   * A scoped body with NO pattern that nonetheless READS the imported name, so it cannot be
   * constant-folded away. Pairs with `projrow`, which is the same arithmetic with no CALL.
   */
  callproj: 'MATCH (n:P) CALL (n) { RETURN n.k AS c } RETURN sum(c) AS t',

  /**
   * ⚠️ THE CEILING OF EXTENDING `inlineCorrelatedCall`, hand-written rather than built (item 1661).
   * That rewrite already turns a correlated CALL whose body PASSES THROUGH its pattern variables
   * into a plain `MATCH`, and refuses `callprojx` on one line — `item.expr.kind !== 'var'` — because
   * its body returns an EXPRESSION (`x.k AS c`) rather than a bare variable. This arm is what the
   * extended rewrite would emit, so it prices the target without building it.
   */
  projxhand: 'MATCH (n:P) MATCH (n)-[:E]->(x) LET c = x.k RETURN sum(c) AS t',
};

const one = (text) => Number(query(g, text)[0].t);

// ⚠️ THE ANSWER ASSERTION COMES FIRST. `sumcall` and `inline` must agree, or the pair is two
// questions and the ratio is meaningless.
const answers = Object.fromEntries(Object.entries(ARMS).map(([k, text]) => [k, one(text)]));

if (answers.correlated !== answers.inline) {
  throw new Error(
    `correlated ${answers.correlated} !== inline ${answers.inline} — not an equivalent pair`,
  );
}

if (answers.inline !== edges) {
  throw new Error(`inline ${answers.inline} !== the ${edges} edges built`);
}

// The uncorrelated arms emit one row per OUTER row, so they count `N`.
if (answers.letrow !== N) {
  throw new Error(`letrow ${answers.letrow} !== ${N}`);
}

if (
  answers.outer !== N ||
  answers.uncorrelated !== N ||
  answers.calltrivial !== N ||
  answers.calltrivialscoped !== N
) {
  throw new Error(`an outer-row arm did not answer ${N}: ${JSON.stringify(answers)}`);
}

if (answers.bodyonce !== edges) {
  throw new Error(`bodyonce ${answers.bodyonce} !== the ${edges} edges built`);
}

// ⚠️ THE NEW PAIRS, each asserted EQUIVALENT before any time is read. A CALL arm whose answer
// differs from its inline twin is two questions, and the ratio would be item 1465's error.
for (const [call, twin] of [
  ['callsumrow', 'inlinesumrow'],
  ['callprojx', 'inlineprojx'],
  ['callproj', 'projrow'],
  ['projxhand', 'callprojx'],
]) {
  if (answers[call] !== answers[twin]) {
    throw new Error(
      `${call} ${answers[call]} !== ${twin} ${answers[twin]} — not an equivalent pair`,
    );
  }
}

// And both row-counting pairs must land on the edge count, so the fixture is in the ratio too.
if (answers.callsumrow !== edges || answers.inlinesumrow !== edges) {
  throw new Error(`the sum(1) pair did not answer ${edges}: ${JSON.stringify(answers)}`);
}

const timeOf = (text) => {
  for (let i = 0; i < 2; i += 1) {
    one(text);
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    one(text);

    series.push(performance.now() - t0);
  }

  const warm = series.slice(DROP).sort((a, b) => a - b);

  return { ms: warm[Math.floor(warm.length / 2)], min: Math.min(...series) };
};

const chosen = ARM === undefined ? Object.keys(ARMS) : [ARM];

if (ARM !== undefined && ARMS[ARM] === undefined) {
  throw new Error(`unknown ARM ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const out = {};

for (const name of chosen) {
  const { ms, min } = timeOf(ARMS[name]);

  out[name] = {
    ms: Number(ms.toFixed(3)),
    min: Number(min.toFixed(3)),
    nsPerOuterRow: Number(((ms * 1e6) / N).toFixed(1)),
    answer: answers[name],
  };
}

console.log(JSON.stringify({ n: N, edges, arms: out }, null, 1));
