/**
 * Finds what a write invalidates (item 2246). The churn sweep showed a read following ONE write costs the
 * same 2.25x as a read following a HUNDRED — `per-write` falls as pure 1/W — so the penalty is a FIXED
 * global rebuild charged to the first read after any write, not per-write work.
 *
 * TWO ARMS, ONE SHAPE PER PROCESS. `PROF_ARM=clean` reads repeatedly with NO writes; `PROF_ARM=churn`
 * writes one edge before each read. The frame that appears only in `churn` IS the rebuild.
 *
 * A WALKING shape (`values` after a hop), because `out('E').count()` is the degree-sum closed form and
 * never touches an adjacency memo — item 2245's first attempt timed 0.0 ms and could detect nothing.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 120);
const ARM = process.env.PROF_ARM ?? 'churn';

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

let added = 0;
let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM === 'churn') {
    const a = g.getVertexById(`v${(added * 37 + 1) % N}`);
    const b = g.getVertexById(`v${(added * 91 + 7) % N}`);

    added += 1;
    g.addEdge({ id: `churn-${added}`, from: a, to: b, labels: ['E'], properties: {} });
  }

  rows = toArray(plan, g).length;
}

/* After the loop, outside the measured work — item 2244: a silent subject is indistinguishable from a broken one. */
console.log(`  arm=${ARM} rounds=${ROUNDS} writes=${added} rows=${rows}`);
