/*
 * Item 2077 — WHAT DO `sum`'s TWO PRE-PASSES COST, against a single fused pass?
 *
 * `aggregateOverValues` in `projection.ts`:
 *
 *     case 'sum':
 *       if (values.some(isTemporal)) return temporalSum(values);
 *       if (values.some(Array.isArray)) throw nonNumericAgg();
 *       return values.reduce((s, v) => s + numArg(v), 0);
 *
 * THREE FULL PASSES, AND THE DESIGN IS DELIBERATE — its own header says so: "the operation is
 * chosen by looking at the WHOLE collection (a temporal anywhere means `temporalSum`, an array
 * anywhere throws), which item 467 is the entry about." Neither `some` short-circuits on an
 * all-numeric column, so both scan to the end.
 *
 * THE QUESTION IS WHETHER THAT COSTS ANYTHING MEASURABLE. The passes are over an ALREADY
 * MATERIALIZED array and do only a type test each, so they may be nearly free against the reduce —
 * which is exactly the kind of thing items 2066/2067 showed cannot be assumed either way.
 *
 * THE ARMS MUST PRODUCE THE SAME SUM, or they price different work.
 */
const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);

const values = Array.from({ length: N }, (_, i) => i);

/** The engine's shape: two type pre-passes, then the reduce. */
const isTemporalish = (v) => typeof v === 'object' && v !== null && 'kind' in v;

const threePass = () => {
  if (values.some(isTemporalish)) {
    return -1;
  }

  if (values.some(Array.isArray)) {
    return -2;
  }

  return values.reduce((s, v) => s + Number(v), 0);
};

/** One pass: assume numeric, test each value as it is added, bail on the first offender. */
const onePass = () => {
  let s = 0;

  for (const v of values) {
    if (typeof v === 'object' && v !== null) {
      return -1;
    }

    s += Number(v);
  }

  return s;
};

/** The reduce ALONE, so the pre-passes can be separated from the addition. */
const reduceOnly = () => values.reduce((s, v) => s + Number(v), 0);

const want = (N * (N - 1)) / 2;

for (const { label, fn } of [
  { label: 'three pass', fn: threePass },
  { label: 'one pass', fn: onePass },
  { label: 'reduce only', fn: reduceOnly },
]) {
  if (fn() !== want) {
    throw new Error(`${label} answered ${String(fn())}, expected ${String(want)}`);
  }
}

const time = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(3).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(
    `  ${label.padEnd(16)} ${ms.toFixed(3).padStart(8)} ms   ${((ms * 1e6) / N).toFixed(1).padStart(6)} ns/value`,
  );

  return ms;
};

console.log(`\n  ${N} values, all numeric; every arm sums to ${want}\n`);
const t3 = time('three pass', threePass);
const t1 = time('one pass', onePass);
const ro = time('reduce only', reduceOnly);

console.log(
  `\n  three pass / one pass  = ${(t3 / t1).toFixed(2)}x` +
    `\n  the two pre-passes cost  ${(t3 - ro).toFixed(3)} ms (${(((t3 - ro) * 1e6) / N).toFixed(1)} ns a value)\n`,
);
