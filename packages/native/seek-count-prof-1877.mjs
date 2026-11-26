/**
 * WHERE DOES GQL'S SEEKED COUNT SPEND ITS TIME? (item 1877)
 *
 * The surface-parity probe reports `seek-count` — an equality seek then `count(*)` — at GQL
 * **18.6 us against Gremlin's 7.5**, confirmed over three rounds (GQL 0.01914/0.02014/0.01857,
 * Gremlin 0.00884/0.00751/0.00938). Same question, same fixture, same engine process, both answering
 * 2222. GQL takes `countShortcut` and the index seek IS working (the range twin costs 2.86 ms), so
 * the 2.5x is inside the rung.
 *
 * ONE SHAPE, ONE PROCESS, and the query is looped inside the timed region because a single call
 * is ~19 us — far below profiler resolution. The loop count is what makes the frames appear.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 20_000);

const lines = Array.from(
  { length: N },
  (_, i) =>
    `{"type":"node","id":"v${i}","labels":["P"],"properties":{"age":${i % 90},"k":${i % 50}}}`,
);
const g = deserialize(lines.join('\n'), 'ndjson', new Graph());

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

const Q = process.env.Q ?? 'MATCH (n:P) WHERE n.age = 42 RETURN count(*) AS c';
const built = performance.now();
let acc = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  acc += query(g, Q)[0].c;
}

const ms = performance.now() - t0;

console.log(
  `# fixture ${built.toFixed(0)} ms, query ${ms.toFixed(0)} ms (${((100 * ms) / (built + ms)).toFixed(0)}% of the process)`,
);
console.log(
  `${((ms * 1000) / REPS).toFixed(2)} us/call over ${String(REPS)} calls, acc ${String(acc)}`,
);
