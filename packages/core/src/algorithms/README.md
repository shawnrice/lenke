# Graph algorithms — running them without blocking the thread

The algorithms (`degree`, `connectedComponents`, `labelPropagation`, `pagerank`,
`shortestPath`) are CPU-bound whole-graph computations. On a large graph a single
call can run for seconds, and a synchronous call **blocks the event loop** for that
whole time — freezing a server's other request handling, or a browser/wasm UI. Pick
the surface that matches where you're running.

## 1. Synchronous (default) — small graphs, offline scripts

```ts
import { pagerank } from '@lenke/core';
const scores = pagerank({ iterations: 20 }, graph); // blocks until done
```

Fine when the graph is small or you're in a batch job where blocking is acceptable.

## 2. Native, off-thread (Node) — the production path

The native `@lenke/node` backend runs the whole algorithm on a libuv threadpool
thread (keeping the engine's internal parallelism) and resolves a `Promise`, so the
event loop stays free. Every algorithm has an `Async` twin on the `RustGraph`:

```ts
const g = graphFromNdjson(backend, bytes); // @lenke/native facade over @lenke/node
const scores = await g.pagerankAsync({ iterations: 20, writeProperty: 'pr' });
```

Result is byte-identical to `g.pagerank(...)`. **Single-flight:** while the promise is
pending the graph is locked — any other call on it throws `E_INVALID_GRAPH_OP` until
it settles (the off-thread read must not race a mutation), so `await` it before the
next call. Not available on bun:ffi / wasm (no threadpool); there these fall back to a
blocking call wrapped in a Promise — use option 3 or 4 instead.

## 3. Pure TS, cooperative-yield — in-process responsiveness (incl. browser)

The pure-TS iterative algorithms have `Async` variants that yield to the event loop
between iterations, so the process (or browser UI) stays responsive. Same bytes as the
sync result — the checkpoints only interleave the work, they don't change it.

```ts
import { pagerankAsync, labelPropagationAsync } from '@lenke/core';
const scores = await pagerankAsync({ iterations: 20 }, graph);
```

This does not use extra threads (JS is single-threaded), so it doesn't speed the
computation up — it trades a little total time for a responsive loop. Available for
`pagerankAsync` and `labelPropagationAsync` (the multi-second iterative ones); the
single-pass algorithms don't have a natural checkpoint yet.

## 4. Worker offload — true off-main-thread for pure TS

For genuine parallelism in a pure-TS setting, run the algorithm in a worker. The graph
object isn't structured-cloneable, so pass it as NDJSON. The reusable core is just
"deserialize, run the named algorithm" — the worker wiring differs per runtime.

**Worker entry (shared logic):**

```ts
// algo-worker-core.ts
import { type AlgorithmConfig, connectedComponents, degree, labelPropagation, pagerank, shortestPath, Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

const ALGOS = { degree, connectedComponents, labelPropagation, pagerank, shortestPath };

export function runAlgorithm(ndjson: string, name: keyof typeof ALGOS, config: AlgorithmConfig) {
  const graph = deserialize(ndjson, 'ndjson', new Graph());
  return ALGOS[name](config, graph);
}
```

**Node (`worker_threads`):**

```ts
// worker.ts
import { parentPort } from 'node:worker_threads';
import { runAlgorithm } from './algo-worker-core.js';
parentPort!.on('message', ({ ndjson, name, config }) => {
  parentPort!.postMessage(runAlgorithm(ndjson, name, config));
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
`self.postMessage` in the worker and `new Worker(url, { type: 'module' })` on the main
thread. Cost: serializing the graph to NDJSON in and the rows out.

## Which to use

- **Node server, big graph:** option 2 (`g.pagerankAsync`) — real off-thread, fastest.
- **Node/Bun server, pure-TS graph:** option 4 (worker) for parallelism, or option 3
  to just stay responsive.
- **Browser/wasm:** option 3 to keep the UI responsive, or option 4 (Web Worker) to
  move the work off the render thread entirely.
- **Small graph / script:** option 1.
