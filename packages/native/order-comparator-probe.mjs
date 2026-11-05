/**
 * WHAT DOES `order()`'s COMPARATOR ACTUALLY COST, measured so the answer is about the comparator?
 *
 * `order()` is ~18% of `isolated-gremlin-bench`'s `hoporder` at 200,000 rows (`sortByBys` 11.6% +
 * its closure 3.6% + `orderStep` 2.8%), and `compareTotal` is called ~3.4M times for that sort. The
 * obvious lever is a NUMERIC-SPECIALIZED total order: `compareTotal` handles nulls, temporals,
 * strings, lists and maps, and a column of numbers needs none of it.
 *
 * ⚠️ ONE COMPARATOR PER PROCESS, AND THIS FILE EXISTS BECAUSE THE IN-PROCESS VERSION LIED (item
 * 1513). Timing several comparators in one loop measures the INLINE CACHE, not the comparator. The
 * sort is driven through a wrapper `(a, b) => cmp(a.key, b.key)`, and V8 keeps feedback per SOURCE
 * POSITION — so every iteration of the loop shares one feedback vector at that call site. The first
 * arm runs monomorphic and every later arm runs polymorphic:
 *
 *     forward  (compareTotal first)   compareTotal 19.6   subtract 24.9
 *     reversed (subtract first)       subtract     19.3   compareTotal 30.5
 *
 * Whichever ran FIRST measured ~19-20 ms and whichever ran LAST measured 24-30 ms — including
 * `(a, b) => a - b`, which cannot plausibly be slower than a comparator that type-switches. The
 * ordering WAS the entire effect. This is item 762's redistribution trap reached from the other
 * side: there a change redistributed call sites, here the harness did.
 *
 *     CMP=compareTotal node order-comparator-probe.mjs
 *     CMP=numeric      node order-comparator-probe.mjs
 *
 * Both arms are also checked to AGREE on every numeric pair that matters before a number is
 * printed, because a faster comparator that orders NaN differently is a byte-identity break, not an
 * optimization (`nan-comparison-policy`: sort uses a total order — NaN last, NaN equal to NaN).
 */
import { compareTotal } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);
const DROP = Number(process.env.DROP ?? 3);
const WHICH = process.env.CMP ?? 'compareTotal';

/**
 * A numeric-only total order. ⚠️ NaN LAST and NaN EQUAL TO NaN, which is the sort contract both
 * engines share; the naive `a < b ? -1 : a > b ? 1 : 0` returns 0 for every NaN comparison, which
 * says NaN equals everything.
 */
const numeric = (a, b) => {
  // `Number.isNaN` rather than `a !== a`: the inline form trips `no-self-compare`, and the two
  // measure the same (23.9 ms either way at 200,000, one process per spelling) — which is itself
  // worth knowing, since "the self-compare avoids a call" is the usual reason to reach for it.
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);

  if (an || bn) {
    if (an && bn) {
      return 0;
    }

    return an ? 1 : -1;
  }

  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

const CMPS = { compareTotal, numeric };
const cmp = CMPS[WHICH];

if (cmp === undefined) {
  throw new Error(`unknown CMP ${WHICH}; have ${Object.keys(CMPS).join(',')}`);
}

// ⚠️ AGREEMENT FIRST. Run in BOTH arms so neither can report a time for a comparator that does not
// implement the same order — this is the "assert each arm IS the code it claims" rule applied to
// semantics rather than to the build.
const VALS = [0, -0, 1, -1, Number.NaN, Infinity, -Infinity, 1e308, 5.5, -5.5, 2 ** 53];

for (const a of VALS) {
  for (const b of VALS) {
    if (Math.sign(compareTotal(a, b)) !== Math.sign(numeric(a, b))) {
      throw new Error(`COMPARATORS DISAGREE on (${String(a)}, ${String(b)}) — a time here is void`);
    }
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

// A deterministic permutation, so both arms sort the same sequence of comparisons.
const base = Array.from({ length: N }, (_, i) => (i * 7919) % N);
const reps = [];

for (let r = 0; r < REPS; r += 1) {
  // Re-keyed per rep: `sort` is in place, and sorting an already-sorted array is a different
  // question (and much faster).
  const keyed = base.map((item) => ({ item, key: item }));
  const t0 = performance.now();

  keyed.sort((a, b) => cmp(a.key, b.key));
  reps.push(performance.now() - t0);
}

console.log(
  JSON.stringify({
    cmp: WHICH,
    n: N,
    median: Number(med(reps.slice(DROP)).toFixed(2)),
    min: Number(Math.min(...reps).toFixed(2)),
    series: reps.map((x) => Number(x.toFixed(1))),
  }),
);
