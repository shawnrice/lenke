/**
 * THE GREMLIN TWIN of item 1755/1756 (item 1757): does the uncapped `countRange` cost the Gremlin
 * index-seed path the same way it cost GQL's?
 *
 * `index-seed.ts`'s `rangeCandidate` calls `index.countRange(key, bound)` with no cap, exactly as
 * GQL's range seed did before item 1756. Its gate is the same rule (`SEEK_MAX_FRACTION = 1/8`,
 * `SEEK_FLOOR_ELEMENTS = 4096`), added at item 1322 after an index made a query **5x slower**.
 *
 * ⚠️ MEASURE BEFORE BUILDING. The GQL fix does not transfer by inspection: there `scan` is always
 * the label bucket, while here `seekIsWorthIt(count, scan, total)` takes a `scan` that may be
 * ANOTHER candidate's count, discovered after this one. The safe cap is therefore `sourceSize / 8`
 * (the largest threshold either call site can use) rather than the GQL cap — but none of that is
 * worth writing if the regression is not there.
 *
 * ⚠️ `n` IS THE HIGH-CARDINALITY COLUMN (20,000 distinct) and `k` the low one (97). Item 1755
 * established that the cost tracks CARDINALITY, not selectivity, so the pair is the control.
 *
 *     INDEXED=1 SHAPE=rangewide node gremlin-range-count-probe.mjs
 */
import { Graph } from '@lenke/core';
import { count, has, hasLabel, lt, toArray, traversal, V } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const N = Number(process.env.N ?? 300);
const INDEXED = process.env.INDEXED === '1';
const SHAPE = process.env.SHAPE ?? 'rangewide';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

if (INDEXED) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

// Built once: Gremlin has no parameter binding, so a plan built per rep would mix construction in.
const PLANS = {
  // ~50% selective over 20,000 DISTINCT values — the shape that regressed in GQL.
  rangewide: traversal(V(), hasLabel('P'), has('n', lt(10_000)), count()),
  // ~50% selective over 97 distinct values — the cardinality control, which must NOT regress.
  rangelowcard: traversal(V(), hasLabel('P'), has('k', lt(48)), count()),
  // Highly selective, where the seek genuinely pays and must stay fast.
  rangetight: traversal(V(), hasLabel('P'), has('n', lt(10)), count()),
};

const plan = PLANS[SHAPE];

if (plan === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(PLANS).join(',')}`);
}

const EXPECTED = { rangewide: 10_000, rangelowcard: 9906, rangetight: 10 };
let answer;
const t0 = performance.now();

for (let i = 0; i < N; i += 1) {
  [answer] = toArray(plan, g);
}

const ms = performance.now() - t0;

// The answer is asserted, not printed and ignored (item 1749): a count shape returns one row
// whatever the count is, so only the VALUE can tell an answer-equivalent arm from a broken one.
if (answer !== EXPECTED[SHAPE]) {
  throw new Error(
    `${SHAPE} answered ${String(answer)}, expected ${EXPECTED[SHAPE]} — not answer-equivalent, so its timing is meaningless`,
  );
}

console.log(
  JSON.stringify({
    shape: SHAPE,
    indexed: INDEXED,
    n: N,
    answer,
    ms: Number(ms.toFixed(1)),
    usPerQuery: Number(((ms * 1000) / N).toFixed(1)),
  }),
);
