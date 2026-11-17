import { isSliceable, type Traverser } from './runtime.js';

export const takeTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  let i = 0;

  for (const t of stream) {
    if (i >= n) {
      return;
    }

    yield t;
    i++;
  }
};

export const skipTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  let i = 0;

  for (const t of stream) {
    if (i < n) {
      i++;
      continue;
    }

    yield t;
  }
};

/*
 * ⚠️ A RING, NOT `push` + `shift` (item 2082). The old form moved every surviving element one slot on
 * each row past `n`; measured by hand over 200,000 rows (medians of 14, two rounds):
 *
 *     walk alone (control)   0.222 ms
 *     push + shift           0.960        -> 0.74 ms of buffering
 *     ring store             0.286        -> 0.064 ms
 *
 * ⚠️ 0.74 ms IS ~7% OF THE QUERY IT WAS FOUND IN, under CLAUDE.md's noise floor — so this is not sold
 * as the win (the fused rung in `node-values.ts` is). It is here because the ring is strictly less work
 * for the same answer, and it reaches every `tail` shape the fusion declines.
 *
 * ⚠️⚠️ **`n < 1` STILL CONSUMES THE STREAM, AND AN EARLY `return` HERE WAS A REAL DIVERGENCE.** The
 * first version of this guard returned without touching the stream — and `store('x').tail(0).cap('x')`
 * then read a bag of **0** where HEAD's unconditional loop read **5**, because `store` is lazy by
 * contract (items 2070/2078) and only banks what actually flows through it. A perf change must not
 * move that, so the zero arm drains. ⚠️ `% 0` is NaN, which is why it is a separate arm at all rather
 * than something the ring can absorb.
 */
export const tailTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  if (n < 1) {
    // ⚠️ DRAIN, DO NOT SKIP — see the note above. The count is unused; the PULL is the point.
    let drained = 0;

    for (const _t of stream) {
      drained++;
    }

    void drained;

    return;
  }

  const buf: Traverser<unknown>[] = new Array<Traverser<unknown>>(n);
  let seen = 0;

  for (const t of stream) {
    buf[seen % n] = t;
    seen++;
  }

  // ⚠️ The oldest surviving row is at `seen % n` once the ring has WRAPPED, and at 0 before that.
  const kept = seen < n ? seen : n;
  const start = seen < n ? 0 : seen % n;

  for (let i = 0; i < kept; i++) {
    yield buf[(start + i) % n];
  }
};

// Local-scope slice helpers. Operate on a single traverser's iterable value
// (typically an array produced by `fold()` or a list-cardinality projection).
// `isSliceable` lives in `runtime.ts` (shared with the local-scope
// aggregations).
export const sliceLocal = (v: unknown, start: number, end: number): unknown => {
  if (!isSliceable(v)) {
    return v;
  }

  const arr = [...v];

  return arr.slice(start, end === Infinity ? undefined : end);
};

export const tailLocal = (v: unknown, n: number): unknown => {
  if (!isSliceable(v)) {
    return v;
  }

  const arr = [...v];

  return n >= arr.length ? arr : arr.slice(arr.length - n);
};

// Mulberry32 PRNG — tiny, fast, fully-specified. `sample(n)` uses it with a
// FIXED seed so the pseudo-random selection is reproducible AND byte-identical
// with the Rust engine, which runs the same algorithm. The seed constant and the
// draw/shuffle order must match `crates/lenke-engine/src/gremlin.rs`.
const SAMPLE_SEED = 0x9e3779b9;

const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); // xor is commutative → matches Rust

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// `sample(n)` — a pseudo-random partial Fisher-Yates pick-N over the stream,
// seeded (not `Math.random`) so it's reproducible and matches the Rust engine.
export const sampleStep = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  const buf = [...stream];
  const k = Math.min(n, buf.length);
  const rand = mulberry32(SAMPLE_SEED);

  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (buf.length - i));
    const tmp = buf[i];
    buf[i] = buf[j]!;
    buf[j] = tmp;
  }

  for (let i = 0; i < k; i++) {
    yield buf[i];
  }
};
