import { type RunContext, startTraverser, type Traverser } from './_internals.js';

export const aggregateStep = function* (
  stream: Iterable<Traverser<unknown>>,
  key: string,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!ctx.sideEffects.has(key)) {
      ctx.sideEffects.set(key, []);
    }
    ctx.sideEffects.get(key)!.push(t.value);
    yield t;
  }
};

// Force eager materialization of the upstream stream. With v2's lack of
// bulk traversers there's nothing to collapse — this just guarantees the
// upstream side-effects have been driven to completion before downstream
// reads them.
export const barrierStep = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  const buffered = [...stream];
  yield* buffered;
};

// `cap(key)` is a barrier: drain the upstream stream first (which is what
// populates side-effect bags via `aggregate`), then yield the bag as a single
// traverser.
export const capStep = function* (
  stream: Iterable<Traverser<unknown>>,
  ctx: RunContext,
  key: string,
): Iterable<Traverser<unknown>> {
  for (const _ of stream) {
    // intentionally drain
  }
  yield startTraverser(ctx.sideEffects.get(key) ?? []);
};
