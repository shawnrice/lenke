/**
 * ⚠️⚠️ **`node --heap-prof` DOES NOT WORK FOR THIS WORKLOAD (item 2249), so this measures allocation
 * DIRECTLY.** Two attempts at the sampling heap profiler reported 3.4 MB and then 4.1 MB total for runs that
 * materialize 80,000-320,000 rows per round — physically impossible — with Node's own module loader as the
 * top frame both times, and +7 KB/round of churn delta. It is missing ~95% of allocations, so its silence
 * is not evidence.
 *
 * 🔑 `process.memoryUsage().heapUsed` around each phase is crude but DIRECT: it cannot attribute to a frame,
 * but it answers the question item 2248 actually left — **is the first-read-after-write penalty accompanied
 * by extra ALLOCATION (a rebuilt structure) or not (pure recomputation over existing data)?**
 *
 * ⚠️ `heapUsed` moves with GC as well as allocation, so the run reports the per-phase deltas across many
 * rounds AND the series, not a single pair — a GC between samples shows up as a negative delta rather than
 * quietly biasing a mean.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 20);
const ARM = process.env.ARM ?? 'churn';

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
const plan = traversal(V(), hasLabel('User'), out('E'), values('team'));
const read = (): number => toArray(plan, g).length;

let added = 0;

const write = (): void => {
  const a = g.getVertexById(`v${(added * 37 + 1) % N}`);
  const b = g.getVertexById(`v${(added * 91 + 7) % N}`);

  if (a === null || b === null) {
    throw new Error('fixture vertex missing');
  }

  added += 1;
  g.addEdge({ id: `alloc-${added}`, from: a, to: b, labels: ['E'], properties: {} });
};

for (let r = 0; r < 4; r += 1) {
  read();
}

const mb = (x: number): number => x / 1e6;
const heap = (): number => process.memoryUsage().heapUsed;

const readAlloc: number[] = [];
const readMs: number[] = [];

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM === 'churn') {
    write();
  }

  const h0 = heap();
  const t0 = performance.now();

  read();
  readMs.push(performance.now() - t0);
  readAlloc.push(mb(heap() - h0));
}

const med = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

console.log(
  `  ARM=${ARM.padEnd(6)} N=${N}  read ${med(readMs.slice(2)).toFixed(2)} ms   heapUsed delta per read ${med(readAlloc.slice(2)).toFixed(1)} MB   writes=${added}`,
);
console.log(`         alloc series ${readAlloc.map((x) => x.toFixed(0)).join(' ')}`);
