/**
 * ⚠️⚠️ **SUSTAINED INTERLEAVED READ/WRITE CHURN (item 2246).** Item 2245 showed a SINGLE write is clean:
 * correct answer, no demotion, and the per-element memos (`#adjTo`, `#box`, `#toV`) re-arm on the next
 * read. 🔑 But "re-arms on the next read" is exactly the property that can THRASH when writes keep
 * arriving — every write invalidates, every read re-fills, and a workload that alternates pays the refill
 * every time without ever amortizing it.
 *
 * ⚠️ This is the user's real workload shape, not a synthetic one: a people-graph taking corrections and
 * retractions between queries.
 *
 * **THE KNOB IS WRITES-PER-READ.** At `W=0` the read is the warm baseline; as `W` grows each read follows
 * more invalidation. The question is whether per-read cost grows with `W` (thrash), stays flat
 * (invalidation is cheap or scoped), or grows then plateaus (bounded refill).
 *
 * 🔑 Two things this probe does deliberately:
 *
 * - **A WALKING shape**, not a count. `out('E').count()` is the degree-sum CLOSED FORM and never touches an
 *   adjacency memo — item 2245's first attempt timed 0.0 ms and could not have detected anything.
 * - **The reads are COUNTED AND CHECKED.** A write makes the next read's row count predictable, so a stale
 *   memo shows up as a wrong number rather than only as a timing anomaly.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const W = Number(process.env.W ?? 1);

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

/** Row count is the answer here — one row per edge — so a stale adjacency shows as a wrong number. */
const read = (): number => toArray(plan, g).length;

let added = 0;

/** `W` fresh edges, each between vertices that already have four, so no vertex becomes a special case. */
const write = (): void => {
  for (let i = 0; i < W; i += 1) {
    const a = g.getVertexById(`v${(added * 37 + 1) % N}`);
    const b = g.getVertexById(`v${(added * 91 + 7) % N}`);

    if (a === null || b === null) {
      throw new Error('fixture vertex missing');
    }

    added += 1;
    g.addEdge({ id: `churn-${added}`, from: a, to: b, labels: ['E'], properties: {} });
  }
};

/* WARM — fill every memo and let the JIT settle before any write happens. */
for (let r = 0; r < 4; r += 1) {
  read();
}

const base = ((): number => {
  const xs: number[] = [];

  for (let r = 0; r < 5; r += 1) {
    const t = performance.now();

    read();
    xs.push(performance.now() - t);
  }

  xs.sort((a, b) => a - b);

  return xs[Math.floor(xs.length / 2)] ?? 0;
})();

const series: number[] = [];
let wrong = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  write();

  const expected = N * 4 + added;
  const t = performance.now();
  const n = read();

  series.push(performance.now() - t);

  if (n !== expected) {
    wrong += 1;
  }
}

const settled = series.slice(2).sort((a, b) => a - b);
const median = settled[Math.floor(settled.length / 2)] ?? 0;

console.log(
  `  W=${String(W).padStart(4)}  warm-read ${base.toFixed(2)} ms   after-${W}-writes ${median.toFixed(2)} ms   ${(median / base).toFixed(2)}x   per-write ${(((median - base) * 1000) / Math.max(W, 1)).toFixed(1)} us   wrong=${wrong}/${ROUNDS}`,
);
console.log(`        series ${series.map((x) => x.toFixed(1)).join(' ')}`);
