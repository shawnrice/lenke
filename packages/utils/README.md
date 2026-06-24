# @pl-graph/utils

> Small, dependency-free helper functions shared across the @pl-graph toolkit.

A handful of low-level utilities: strict array equality, an identity function, random ID generation, and opt-in timing instrumentation. Reach for it when you need these primitives without pulling in a larger utility library.

## Install

```bash
bun add @pl-graph/utils
```

## Usage

```ts
import {
  arraysAreEqual,
  identity,
  rando,
  timer,
  sampleTimer,
} from '@pl-graph/utils';

// Strict (===) element-wise array comparison
arraysAreEqual([1, 2, 3], [1, 2, 3]); // true
arraysAreEqual([1, 2], [1, 2, 3]); // false

// Identity, useful as a default mapper/predicate
identity({ id: 1 }); // { id: 1 }

// Non-cryptographic random id (crypto.randomUUID under the hood)
const id = rando(); // e.g. "3f29c1e2-..."

// One-shot timing: call the returned function when the work is done.
// Timing is opt-in — set globalThis.__DEV__ = true to enable logging.
globalThis.__DEV__ = true;

const done = timer('build-index');
buildIndex();
done(); // logs: [TIMER] build-index took <n>ms

// Repeated timing with aggregate statistics
const st = sampleTimer('query');
for (const q of queries) {
  const stop = st.getTimer();
  run(q);
  stop();
}
st.stats(); // logs sample count, mean, median, std-dev, min, max
st.reset(); // clear collected samples
```

## API

- `arraysAreEqual(a: unknown[], b: unknown[]): boolean` — `true` when both arrays have the same length and equal elements by `===`.
- `identity<T>(x: T): T` — returns its argument unchanged.
- `rando(): string` — a non-cryptographically-secure random string via `crypto.randomUUID()`.
- `timer(name: string): () => void` — start a one-shot timer; call the returned function to log elapsed milliseconds.
- `sampleTimer(name: string): SampleTimer` — accumulate timing samples. Returns `{ getTimer, stats, reset }`, where `getTimer()` returns a stop function per sample, `stats()` logs aggregate statistics, and `reset()` clears collected samples.
- `type UnknownObject` — alias for `Record<string, unknown>`.

`timer` and `sampleTimer` only log when timing is enabled. Set `globalThis.__DEV__ = true` (typically in a dev/test entry point); otherwise they return no-ops.

## License

Apache-2.0
