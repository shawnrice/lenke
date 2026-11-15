// Item 1919 — WHAT IS THE CEILING for reducing the string comparison inside `min`/`max`?
//
// `V().out(E).values(s).min()` measures **199.92 ms against the same walk MATERIALIZING the strings
// at 76.74** — a fold that builds no array costing 2.6x the arm that builds an 800,000-element one.
// The numeric twin is 78.50 against 62.23, only 1.26x. Subtracting the two floors leaves ~107 ms on
// 800,000 comparisons: **~134 ns per string comparison.**
//
// ⚠️ THE PROFILE POINTS SOMEWHERE ELSE AND IS MISLEADING HERE. It puts 60.3% in the CSR walk's lazy
// iterator (`walk$3`'s generator) and only **1.8% in `compareCodePoints`** — but
// `compareCodePoints`' fast path is three comparisons and inlines into its caller, so its cost is
// attributed to the generator frame. [[frame-attribution-trap]]: a frame is attribution until a
// deletion test with a control says otherwise, and the two FLOORS above are that control.
//
// 🔑 WHAT THE REDUCTION WOULD BE. `compareTotal` runs a chain per comparison: four null tests, the
// number/NaN block, two `typeRank` calls, the `cmpSameType` dispatch, and inside
// `compareCodePoints` a surrogate test on BOTH strings — all to re-establish a fact that is
// per-string and invariant. For two surrogate-free strings the answer is literally
// `a < b ? -1 : a > b ? 1 : 0`.
//
// ⚠️⚠️ AND `sort-key-specialize.ts` ALREADY DOES THIS FOR `order()` — read its note before
// believing anything here. It records that the STRING arm is worth having (item 1712's correctness
// fix cost 1.55x-1.68x and this is what made it affordable) while a NUMERIC arm was built, measured
// six times at 0.93x-1.18x and dropped, because an O(n) classification scan ate the win. Its note
// names the open question as "a cheaper classification".
//
// 🔑 A FOLD IS WHERE THAT CHEAPER CLASSIFICATION EXISTS: it can classify AS IT FOLDS, for free,
// because it already visits every element once. A sort must classify BEFORE it can sort. Same
// structural difference item 1918 found for the numeric arm — but unlike that one, `min`/`max` over
// a total order are ORDER-INVARIANT, so there is no summation-order question and no byte-identity
// hazard: the answer is the same whatever order the walk visits in.
//
//     bun strcmp-ceiling-1919.mjs
import { HAS_SURROGATE, compareCodePoints } from '@lenke/core';

const COUNT = Number(process.env.COUNT ?? 800000);
const REPS = Number(process.env.REPS ?? 9);

// The fixture's own `s` values: 7 distinct short ASCII strings, cycled.
const vals = Array.from({ length: COUNT }, (_, i) => `s${i % 7}`);

// ⚠️ A SECOND SET WITH A SURROGATE, so the arm that must DECLINE is measured too rather than
// assumed free. One in every 1000 carries an astral character.
const mixed = Array.from({ length: COUNT }, (_, i) =>
  i % 1000 === 0 ? `s\u{1F600}${i}` : `s${i % 7}`,
);

/**
 * A transcription of `compareTotal`'s path for two non-null strings, used as the PRE arm. Taken
 * from the real one rather than guessed: four null tests, the number/NaN block, the type ranks, the
 * same-type dispatch, then `compareCodePoints`.
 *
 * ⚠️ IT IS A TRANSCRIPTION AND SO IT IS EVIDENCE ABOUT THE SHAPE, NOT A MEASUREMENT OF THE ENGINE.
 * The engine's own number is the 199.92 ms row; this prices how much of it the reduction could
 * remove.
 */
const typeRank = (v) => {
  if (v === null || v === undefined) {
    return 0;
  }

  if (typeof v === 'string') {
    return 1;
  }

  return typeof v === 'number' ? 2 : 3;
};

const fullCompare = (a, b) => {
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : -1;
  }

  if (b === null || b === undefined) {
    return 1;
  }

  if (typeof a === 'number' || typeof b === 'number') {
    const an = Number.isNaN(a) ? 1 : 0;
    const bn = Number.isNaN(b) ? 1 : 0;

    if (an !== bn) {
      return an - bn;
    }
  }

  const ra = typeRank(a);
  const rb = typeRank(b);

  if (ra !== rb) {
    return ra < rb ? -1 : 1;
  }

  return typeof a === 'string' ? compareCodePoints(a, b) : 0;
};

const ARMS = {
  // PRE: the full chain, once per element.
  full: (xs) => {
    let [best] = xs;

    for (let i = 1; i < xs.length; i += 1) {
      if (fullCompare(xs[i], best) < 0) {
        best = xs[i];
      }
    }

    return best;
  },
  // The engine's own comparator, to check the transcription is not flattering the PRE arm.
  real: (xs) => {
    let [best] = xs;

    for (let i = 1; i < xs.length; i += 1) {
      if (compareCodePoints(xs[i], best) < 0) {
        best = xs[i];
      }
    }

    return best;
  },
  // POST: classify AS WE FOLD. While every string seen so far is surrogate-free, a plain `<` is
  // the same answer as code-point order; the first surrogate falls back for good.
  fused: (xs) => {
    let [best] = xs;
    let plain = typeof best === 'string' && !HAS_SURROGATE.test(best);

    for (let i = 1; i < xs.length; i += 1) {
      const v = xs[i];

      if (plain && typeof v === 'string' && !HAS_SURROGATE.test(v)) {
        if (v < best) {
          best = v;
        }

        continue;
      }

      plain = false;

      if (fullCompare(v, best) < 0) {
        best = v;
      }
    }

    return best;
  },
  // The unreachable floor: a plain `<` with NO classification at all. Wrong for a surrogate, and
  // here only to say how much of the gap the classification itself costs.
  bare: (xs) => {
    let [best] = xs;

    for (let i = 1; i < xs.length; i += 1) {
      if (xs[i] < best) {
        best = xs[i];
      }
    }

    return best;
  },
};

/** Objects rather than tuples, so `label` is never inferred as possibly-an-array in a template. */
const SETS = [
  { label: 'ASCII only', xs: vals },
  { label: '1-in-1000 astral', xs: mixed },
];

for (const { label, xs } of SETS) {
  console.log(`\n# ${label} (${xs.length} values)`);

  const answers = {};
  const times = {};

  for (const [name, fn] of Object.entries(ARMS)) {
    const ser = [];

    for (let r = 0; r < REPS + 2; r += 1) {
      const t0 = performance.now();
      const got = fn(xs);
      const ms = performance.now() - t0;

      answers[name] = got;

      if (r >= 2) {
        ser.push(ms);
      }
    }

    ser.sort((a, b) => a - b);
    times[name] = ser[ser.length >> 1];
    console.log(
      `  ${name.padEnd(6)} ${times[name].toFixed(2)} ms   answer ${JSON.stringify(answers[name])}`,
    );
  }

  // ⚠️ THE ANSWER CHECK, because a faster arm that answers differently is not a faster arm. `bare`
  // is EXPECTED to differ on the astral set — that is why it is unreachable.
  const ref = answers.full;

  for (const name of ['real', 'fused']) {
    if (answers[name] !== ref) {
      console.log(
        `  ❌ ${name} answered ${JSON.stringify(answers[name])}, full answered ${JSON.stringify(ref)}`,
      );
    }
  }

  if (answers.bare !== ref) {
    console.log(
      `  ⚠️ bare answered ${JSON.stringify(answers.bare)} vs ${JSON.stringify(ref)} — as expected, it is not a candidate`,
    );
  }

  console.log(
    `  => the reduction is worth ${(times.full / times.fused).toFixed(2)}x on this slice ` +
      `(${(times.full - times.fused).toFixed(2)} ms of the engine row's ~107 ms comparison share)`,
  );
}
