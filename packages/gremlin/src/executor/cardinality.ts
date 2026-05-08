import { isSliceable, type Traverser } from './_internals.js';

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

export const tailTraversers = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  const buf: Traverser<unknown>[] = [];
  for (const t of stream) {
    buf.push(t);
    if (buf.length > n) {
      buf.shift();
    }
  }
  yield* buf;
};

// Local-scope slice helpers. Operate on a single traverser's iterable value
// (typically an array produced by `fold()` or a list-cardinality projection).
// `isSliceable` lives in `_internals.ts` (shared with the local-scope
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

// `sample(n)` — Fisher-Yates pick-N over the materialized stream.
export const sampleStep = function* (
  stream: Iterable<Traverser<unknown>>,
  n: number,
): Iterable<Traverser<unknown>> {
  const buf = [...stream];
  const k = Math.min(n, buf.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (buf.length - i));
    const tmp = buf[i]!;
    buf[i] = buf[j]!;
    buf[j] = tmp;
  }
  for (let i = 0; i < k; i++) {
    yield buf[i]!;
  }
};
