# Graph algorithms

`degree`, `connectedComponents`, `labelPropagation`, `pagerank`, `shortestPath` —
whole-graph computations over the public `Graph` surface, data-last and dual-form
(`pagerank(config, graph)` or `pagerank(config)(graph)`), byte-identical to the
native engine.

## They're async — and that's the whole point

These are CPU-bound and can run for seconds on a large graph. A synchronous call
would **block the event loop** for that whole time (freezing a server's other
requests, or a browser/wasm UI). So there is exactly one form of each — an **async**
function that resolves a `Promise` and never blocks the loop:

```ts
import { pagerank } from '@lenke/core';

const scores = await pagerank({ iterations: 20 }, graph);
```

No `sync` vs `async` split, no `Async` suffix. The pure-TS functions interleave with
the event loop on a **time budget**, not a fixed item count: the generator
checkpoints often and cheaply, and the driver only actually yields once a chunk has
run for ~5 ms (React's frame-slice), so each synchronous burst stays **~5–10 ms** —
under one 16.7 ms frame — regardless of the algorithm or the graph size. (A
count-based threshold can't do this: per-item cost varies ~25× across these
algorithms, so 16k items is ~4 ms for degree but ~100 ms for Dijkstra.) It yields
via `setImmediate`/`MessageChannel` (not `setTimeout(0)`, which browsers clamp to
~4 ms). The result is exactly what the computation produces — the checkpoints only
interleave the same work.

## Native (Node) runs off the JS thread

On the native `@lenke/node` backend the `RustGraph` methods have the same async
shape, but the whole computation runs on a **libuv threadpool thread** (keeping the
engine's rayon parallelism) — genuinely off the main thread, not just yielding:

```ts
const g = graphFromNdjson(backend, bytes); // @lenke/native facade over @lenke/node
const scores = await g.pagerank({ iterations: 20, writeProperty: 'pr' });
```

**Single-flight:** while the promise is pending the graph is locked — any other call
on it throws `E_INVALID_GRAPH_OP` until it settles (the off-thread read must not race
a mutation), so `await` it before the next call. On the bun:ffi / wasm backends
(no threadpool) the method still resolves the same rows but the run blocks the
thread during compute — prefer the `@lenke/core` functions there (they yield).

## Worker offload — parallelism for pure TS

For true off-main-thread execution in a pure-TS setting, run the algorithm in a
worker. The graph object isn't structured-cloneable, so pass it as NDJSON. The
reusable core is just "deserialize, run the named algorithm":

```ts
// algo-worker-core.ts
import {
  type AlgorithmConfig,
  connectedComponents,
  degree,
  labelPropagation,
  pagerank,
  shortestPath,
  Graph,
} from '@lenke/core';
import { deserialize } from '@lenke/serialization';

const ALGOS = { degree, connectedComponents, labelPropagation, pagerank, shortestPath };

export async function runAlgorithm(
  ndjson: string,
  name: keyof typeof ALGOS,
  config: AlgorithmConfig,
) {
  const graph = deserialize(ndjson, 'ndjson', new Graph());
  return ALGOS[name](config, graph); // already a Promise
}
```

**Node (`worker_threads`):**

```ts
// worker.ts
import { parentPort } from 'node:worker_threads';
import { runAlgorithm } from './algo-worker-core.js';
parentPort!.on('message', async ({ ndjson, name, config }) => {
  parentPort!.postMessage(await runAlgorithm(ndjson, name, config));
});

// main.ts
import { Worker } from 'node:worker_threads';
const worker = new Worker(new URL('./worker.js', import.meta.url));
const rows = await new Promise((resolve) => {
  worker.once('message', resolve);
  worker.postMessage({ ndjson, name: 'pagerank', config: { iterations: 20 } });
});
```

**Browser (`Web Worker`):** identical shape with `self.onmessage` /
`self.postMessage` in the worker and `new Worker(url, { type: 'module' })` on the
main thread. Cost: serializing the graph to NDJSON in and the rows out.

## Which to use

- **Node server, big graph:** the native `g.pagerank(...)` — real off-thread, fastest.
- **Node/Bun server, pure-TS graph:** the `@lenke/core` functions (yield to stay
  responsive), or a worker for parallelism.
- **Browser/wasm:** the `@lenke/core` functions to keep the UI responsive, or a Web
  Worker to move the work off the render thread entirely.
