/**
 * ⚠️⚠️⚠️ **IS ITEM 2246's 2.25x THE MUTATION DRAIN? (item 2247)** The churn sweep found a fixed ~1.6 ms
 * penalty on the first read after ANY write — one write costs the same as a hundred. A CPU profile
 * nominated `pick` and `drain`, and `pick` was rejected (its delta exceeded the total, and the name resolved
 * to a `choose()` rung the query never uses). **`drain` survives that rejection, and there is a mechanism
 * for it**: the graph's mutation events are drained on a MICROTASK, and item 2246's loop is SYNCHRONOUS —
 * `write(); read();` with no `await` — so the microtask never runs between them.
 *
 * 🔑 **ONE DECISIVE ARM: yield a microtask between the write and the read.**
 *
 *     sync      write(); read()                        <- item 2246's shape, 2.25x
 *     drained   write(); await Promise.resolve(); read()
 *     none      read() only                            <- the floor
 *
 * ✅ If `drained` is fast, the penalty IS the deferred drain and the finding is actionable. ⚠️ If `drained`
 * is equally slow, the drain is exonerated and the cause is elsewhere — either way one run settles it,
 * which a profile at this resolution could not.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const ARM = process.env.ARM ?? 'sync';

const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) => `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 97}}}`,
  );
  let id = 0;

  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < N; i += 1) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["E"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

const g = deserialize(doc, 'ndjson', new Graph());
/*
 * 🔑 **AND A SECOND KNOB: THE LABEL FILTER.** Draining removed only ~40% of the penalty, and item 2246
 * showed one write costs the same as a hundred — a GLOBAL rebuild. `hasLabel('User')` reads
 * `verticesByLabel`, a global index a write could invalidate, so `SHAPE=nolabel` drops it. If the residual
 * penalty goes with it, the label index is the rest; if not, it is the adjacency side.
 */
const plan =
  process.env.SHAPE === 'nolabel'
    ? traversal(V(), out('E'), values('team'))
    : traversal(V(), hasLabel('User'), out('E'), values('team'));
const read = (): number => toArray(plan, g).length;

let added = 0;

const write = (): void => {
  const a = g.getVertexById(`v${(added * 37 + 1) % N}`);
  const b = g.getVertexById(`v${(added * 91 + 7) % N}`);

  if (a === null || b === null) {
    throw new Error('fixture vertex missing');
  }

  added += 1;
  g.addEdge({ id: `drain-${added}`, from: a, to: b, labels: ['E'], properties: {} });
};

for (let r = 0; r < 4; r += 1) {
  read();
}

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const base: number[] = [];

for (let r = 0; r < 5; r += 1) {
  const t = performance.now();

  read();
  base.push(performance.now() - t);
}

const series: number[] = [];
let wrong = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM !== 'none') {
    write();
  }

  if (ARM === 'drained') {
    /* 🔑 THE WHOLE EXPERIMENT: let the queued mutation events drain before the read. */
    await Promise.resolve();
  }

  const expected = N * 4 + added;
  const t = performance.now();
  const n = read();

  series.push(performance.now() - t);

  if (n !== expected) {
    wrong += 1;
  }
}

const b = med(base);
const a = med(series.slice(2));

console.log(
  `  ARM=${ARM.padEnd(8)} floor ${b.toFixed(2)} ms   after ${a.toFixed(2)} ms   ${(a / b).toFixed(2)}x   writes=${added}  wrong=${wrong}/${ROUNDS}`,
);
console.log(`           series ${series.map((x) => x.toFixed(1)).join(' ')}`);
