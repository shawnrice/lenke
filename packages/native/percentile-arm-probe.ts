/**
 * WHICH percentile algorithm should the TS engine use? (item 1162 follow-up)
 *
 * Item 1162 made native answer a percentile with one order statistic instead of a sort
 * (3717 -> 390 us, 9.5x) and priced the TS engine at 31.2 ms against 4.3 for the same
 * materialization — so the TS fold sorts too. The design transfers, but WHICH fold wins in JS is
 * a different question from which wins in Rust, and worth one probe before building:
 *
 *   A  current      `values.map(numArg).filter(isFinite).sort((a, b) => a - b)`
 *   B  typed sort   copy into a Float64Array, then its NATIVE `.sort()` (no comparator)
 *   C  quickselect  copy into a Float64Array, then a hand-written O(n) selection
 *   D  gather only  the copy alone, so A/B/C each separate from their shared floor
 *
 * In Rust the selection beat the sort 9x. In JS it is NOT obvious: B's sort is native C++ at
 * O(n log n) while C's selection is interpreted at O(n), and which wins depends on the constant,
 * not the exponent. Guessing would be the item-234 mistake in a new language.
 *
 * ⚠️ BYTE-IDENTITY NOTE, which constrains B and C both. `(a, b) => a - b` returns 0 for `-0.0`
 * vs `0.0`, so V8's stable sort keeps them in input order — and the Rust engine's stable
 * `partial_cmp` sort does the same, so the two agree today. But
 * `%TypedArray%.prototype.sort` ORDERS -0 BEFORE +0 by specification, and an unstable selection
 * may return either. So whichever of B/C is chosen needs the same negative-zero decline the Rust
 * side carries. These arms measure speed only; the gather tracks the flag so its cost is in the
 * measurement.
 *
 *   cd packages/native && bun percentile-arm-probe.ts
 */
const N = Number(process.env.PCT_N ?? 200_000);
const REPS = Number(process.env.PCT_REPS ?? 14);

let seed = 0x2f6e2b1;
const nextInt = (bound: number): number => {
  // INTEGER arithmetic: item 702's f64 LCG passed 2^53 and its period collapsed to ~11k draws.
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;

  return seed % bound;
};

const values: unknown[] = Array.from({ length: N }, () => nextInt(1_000_000));
// ALREADY SORTED, which is the input a first-element pivot degrades to O(n^2) on — and it is the
// ORDINARY case for a percentile, not an adversarial one (any column written in ascending order).
// Mutant M6 of item 1163 replaces the median-of-three pivot with the first element and SURVIVES
// every answer test, because it is still correct; this row is what decides whether to keep it.
const sorted: unknown[] = [...(values as number[])].sort((a, b) => a - b);

/** ARM A — what the engine does today, transcribed. */
const armA = (vals: readonly unknown[], frac: number, cont: boolean): number | null => {
  const nums = (vals as number[])
    .map((x) => x)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const n = nums.length;

  if (n === 0) {
    return null;
  }

  if (cont) {
    const rn = frac * (n - 1);
    const lo = Math.floor(rn);
    const hi = Math.ceil(rn);

    return lo === hi ? nums[lo] : nums[lo] + (rn - lo) * (nums[hi] - nums[lo]);
  }

  return nums[Math.min(n - 1, Math.max(0, Math.ceil(frac * n) - 1))];
};

/**
 * The shared gather: finite values into a Float64Array, noting a negative zero on the way.
 * Module scope, not inlined into a closure — a walk inside a returned closure gives unrelated
 * queries a new slow mode (the TS closure-size finding).
 */
const gather = (vals: readonly unknown[]): { buf: Float64Array; n: number; negZero: boolean } => {
  const buf = new Float64Array(vals.length);
  let n = 0;
  let negZero = false;

  for (const v of vals) {
    const x = v as number;

    if (Number.isFinite(x)) {
      if (x === 0 && Object.is(x, -0)) {
        negZero = true;
      }

      buf[n] = x;
      n += 1;
    }
  }

  return { buf, n, negZero };
};

/** ARM B — the native typed-array sort. */
const armB = (vals: readonly unknown[], frac: number, cont: boolean): number | null => {
  const { buf, n } = gather(vals);

  if (n === 0) {
    return null;
  }

  const nums = buf.subarray(0, n);

  nums.sort();

  if (cont) {
    const rn = frac * (n - 1);
    const lo = Math.floor(rn);
    const hi = Math.ceil(rn);

    return lo === hi ? nums[lo] : nums[lo] + (rn - lo) * (nums[hi] - nums[lo]);
  }

  return nums[Math.min(n - 1, Math.max(0, Math.ceil(frac * n) - 1))];
};

/**
 * The median of three values — `selectNth`'s pivot.
 *
 * A NAMED function rather than a nested ternary inline, for two reasons. It is what the linter
 * asks for, and it makes the pivot ARITHMETIC unit-testable on its own: the pivot CHOICE is
 * answer-equivalent (a first-element pivot is equally correct — item 1163, mutant M6), so no
 * differential test can pin it, and the standing remedy for that is to extract the arithmetic as
 * a pure function and test it directly.
 */
const medianOfThree = (x: number, y: number, z: number): number => {
  if (x < y) {
    if (y < z) {
      return y;
    }

    return x < z ? z : x;
  }

  if (x < z) {
    return x;
  }

  return y < z ? z : y;
};

/**
 * In-place Hoare quickselect: after it returns, `a[k]` holds the k-th smallest and everything
 * below k is <= it. Median-of-three pivot, so a sorted or reverse-sorted input does not degrade
 * to O(n^2) — the degenerate case a percentile over an already-ordered column would hit every
 * time.
 */
const selectNth = (a: Float64Array, n: number, k: number): number => {
  let lo = 0;
  let hi = n - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // median-of-three into a[lo]
    const pivot = medianOfThree(a[lo], a[mid], a[hi]);
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (a[i] < pivot) {
        i += 1;
      }

      while (a[j] > pivot) {
        j -= 1;
      }

      if (i <= j) {
        const t = a[i];

        a[i] = a[j];
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }

    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      return a[k];
    }
  }

  return a[k];
};

/** ARM C — the O(n) selection, with the second adjacent statistic taken as a min scan. */
const armC = (vals: readonly unknown[], frac: number, cont: boolean): number | null => {
  const { buf, n } = gather(vals);

  if (n === 0) {
    return null;
  }

  if (cont) {
    const rn = frac * (n - 1);
    const lo = Math.floor(rn);
    const hi = Math.ceil(rn);
    const loVal = selectNth(buf, n, lo);

    if (lo === hi) {
      return loVal;
    }

    let hiVal = Infinity;

    for (let i = lo + 1; i < n; i += 1) {
      if (buf[i] < hiVal) {
        hiVal = buf[i];
      }
    }

    return loVal + (rn - lo) * (hiVal - loVal);
  }

  return selectNth(buf, n, Math.min(n - 1, Math.max(0, Math.ceil(frac * n) - 1)));
};

/** ARM D — the gather alone, the floor B and C share. */
const armD = (vals: readonly unknown[]): number => gather(vals).n;

/** `selectNth` with a FIRST-ELEMENT pivot — mutant M6, to price the pivot choice. */
const selectNthFirstPivot = (a: Float64Array, n: number, k: number): number => {
  let lo = 0;
  let hi = n - 1;

  while (lo < hi) {
    const pivot = a[lo];
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (a[i] < pivot) {
        i += 1;
      }

      while (a[j] > pivot) {
        j -= 1;
      }

      if (i <= j) {
        const t = a[i];

        a[i] = a[j];
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }

    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      return a[k];
    }
  }

  return a[k];
};

const armE = (vals: readonly unknown[]): number => {
  const { buf, n } = gather(vals);

  return n === 0 ? NaN : selectNth(buf, n, n >> 1);
};

const armF = (vals: readonly unknown[]): number => {
  const { buf, n } = gather(vals);

  return n === 0 ? NaN : selectNthFirstPivot(buf, n, n >> 1);
};

/**
 * 14 reps, drop the first three as warm-up (they are visibly the JIT tiering up), take the
 * MEDIAN of the rest — item 579's instrument. `min` is the WRONG estimator on this path: the
 * general scalar path plateaus high and emits a rare fast rep, so `min` estimates the two arms
 * differently.
 */
const med = (xs: number[]): number => {
  const warm = xs.slice(3).toSorted((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)];
};

const time = (f: () => unknown): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    f();
    series.push(performance.now() - t);
  }

  return med(series);
};

console.log(`\n# ${N} values, median of ${REPS} dropping 3, three order-alternated rounds\n`);

const ARMS = [
  ['A current  map+filter+sort(cmp)', (c: boolean) => armA(values, 0.5, c)],
  ['B Float64Array native .sort()', (c: boolean) => armB(values, 0.5, c)],
  ['C Float64Array quickselect', (c: boolean) => armC(values, 0.5, c)],
  ['D gather only            [floor]', () => armD(values)],
] as const;

// Agreement BEFORE speed: an arm that is fast and wrong is not a candidate.
for (const cont of [false, true]) {
  const a = armA(values, 0.5, cont);
  const b = armB(values, 0.5, cont);
  const c = armC(values, 0.5, cont);

  if (!(Object.is(a, b) && Object.is(a, c))) {
    throw new Error(`cont=${cont}: arms DISAGREE — A ${a}, B ${b}, C ${c}`);
  }
}

console.log('  all three arms agree on the answer (checked for cont and disc)\n');

const rounds: Record<string, number[]> = {};

for (let round = 0; round < 3; round += 1) {
  // ALTERNATE the order each round, so an arm is not always measured on a cold or a warm heap.
  const order = round % 2 === 0 ? ARMS : [...ARMS].reverse();

  for (const [label, f] of order) {
    rounds[label] ??= [];
    rounds[label].push(time(() => f(false)));
  }
}

console.log('  arm                                 ms (3 rounds)');

for (const [label] of ARMS) {
  const xs = rounds[label].map((x) => x.toFixed(1));

  console.log(`  ${label.padEnd(34)} ${xs.join('  ')}`);
}

// THE PIVOT, on an ALREADY-SORTED column: the question mutant M6 raises and no answer test can.
console.log('\n  pivot choice, over an ALREADY-SORTED column of the same size');
const pivotRows: [string, () => number][] = [
  ['median-of-three  (shipped)', () => armE(sorted)],
  ['first element    (mutant M6)', () => armF(sorted)],
  ['median-of-three, random  [ctl]', () => armE(values)],
];

for (const [label, f] of pivotRows) {
  console.log(`  ${label.padEnd(34)} ${time(f).toFixed(1)} ms`);
}
