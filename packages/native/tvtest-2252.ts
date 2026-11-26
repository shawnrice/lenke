/**
 * **THE PRECONDITION TEST ITEM 2250 SKIPPED (item 2252).** Item 2251 established from
 * `second-ask.ts`'s own documentation that under write-every-read the CSR is **never built**, so the churn
 * penalty is a LOST FAST PATH rather than a rebuild. That mechanism makes a sharp, falsifiable prediction:
 *
 * **the penalty should track `graph.topologyVersion`, not "writes" in general.**
 *
 * `seenBefore` keys on `(graph, topologyVersion, shape)`, so a write that does NOT bump the version leaves
 * the CSR generation reachable and the second ask armed — and must therefore cost nothing. A write that
 * DOES bump it re-arms the first-ask path on every round and must cost the full penalty.
 *
 * Item 2250 accepted a mechanism on its predictions alone and was half wrong; this measures the
 * version delta DIRECTLY alongside the timing, so correlation (or its absence) is visible rather than
 * assumed. Each arm reports `tv/write` — exactly how much `topologyVersion` moved per write it performed.
 */
import { Graph } from '@lenke/core';
import { V, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

const N = Number(process.env.N ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 60);
const ARM = process.env.ARM ?? 'addedge';

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

let n = 0;

/** Each arm performs ONE write of its kind. The `none` arm is the floor. */
const write = (): void => {
  n += 1;

  const a = g.getVertexById(`v${(n * 37 + 1) % N}`);

  if (a === null) {
    throw new Error('fixture vertex missing');
  }

  if (ARM === 'addedge') {
    const b = g.getVertexById(`v${(n * 91 + 7) % N}`);

    if (b === null) {
      throw new Error('fixture vertex missing');
    }

    g.addEdge({ id: `tv-${n}`, from: a, to: b, labels: ['E'], properties: {} });

    return;
  }

  if (ARM === 'setprop') {
    /* A PROPERTY write touches no adjacency, so it should not move `topologyVersion`. */
    a.properties = { ...a.properties, team: (n % 97) + 1000 };

    return;
  }

  if (ARM === 'addvertex') {
    g.addVertex({ id: `tvv-${n}`, labels: ['Other'], properties: { team: 1 } });
  }
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

const tv0 = g.topologyVersion;
const series: number[] = [];

for (let r = 0; r < ROUNDS; r += 1) {
  if (ARM !== 'none') {
    write();
  }

  const t = performance.now();

  read();
  series.push(performance.now() - t);
}

const tvDelta = g.topologyVersion - tv0;
const b = med(base);
const a = med(series.slice(2));

console.log(
  `  ARM=${ARM.padEnd(9)} floor ${b.toFixed(2)} ms   after ${a.toFixed(2)} ms   penalty ${(a - b).toFixed(2)} ms   writes=${n}  tv moved ${tvDelta}  (${n === 0 ? 0 : (tvDelta / n).toFixed(2)} per write)`,
);
