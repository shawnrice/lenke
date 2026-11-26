/**
 * **WHAT DOES AN INDEX ON THE LOOKUP KEY BUY, ON THE PURE-TS ENGINE? (item 2301)**
 *
 * `bun run bench:usage` prints both columns and the gap is the largest in that table — `ts(-)` 1.9k
 * ops/sec against `ts(+)` 679.2k on a 2-hop recommendation. But that harness runs 250 ms batches of
 * MANY shapes in one process, and items 2285/2286/2295 all showed such a sweep both erasing and
 * manufacturing gaps. This measures ONE shape per process, with the index as the only variable.
 *
 * `SHAPE` picks the query; `INDEX=1` creates the index. Both arms print their answer, because an index
 * that changed the answer would invalidate the comparison.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20_000);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'twohop';
const INDEX = process.env.INDEX === '1';

const g = new Graph();

for (let i = 0; i < USERS; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `user${i}`, score: i % 100 } });
}

let s = 0x5eed | 0;
const rnd = () => {
  s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

  return (s >>> 1) % 1_000_000_007;
};

for (let i = 0; i < USERS; i += 1) {
  for (let f = 0; f < 3; f += 1) {
    const to = g.getVertexById(`u${(rnd() + f * 7919) % USERS}`);

    if (to) {
      g.addEdge({
        id: `f${i}_${f}`,
        from: g.getVertexById(`u${i}`),
        to,
        labels: ['FOLLOWS'],
        properties: {},
      });
    }
  }
}

/* AFTER the data, which is how an application adds one to an existing graph. */
if (INDEX) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

const QUERIES = {
  point: 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s',
  twohop: 'MATCH (u:User)-[:FOLLOWS]->()-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c',
};

const text = QUERIES[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/*
 * **WARM-UP IS THE WHOLE MEASUREMENT AT THIS SCALE (item 2302).** Item 2301 used 3 warm-up reps and
 * read the indexed point lookup at 17.3 µs; `bench:usage`, which runs 250 ms BATCHES, reports the same
 * query at 0.63 µs — **27x apart, and the bench is right about the warm steady state an application
 * reaches.** `WARM` makes that explicit instead of implicit.
 */
const WARM = Number(process.env.WARM ?? 3);

for (let w = 0; w < WARM; w += 1) {
  query(g, text, { n: 'user7' });
}

const ts = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  const rows = query(g, text, { n: 'user7' });

  ts.push(performance.now() - t);
  answer = JSON.stringify(rows[0]);
}

const ms = med(ts);

console.log(
  `  USERS=${USERS} SHAPE=${SHAPE.padEnd(7)} INDEX=${INDEX ? 'yes' : 'no '} median ${ms.toFixed(4).padStart(9)} ms   ${(1000 / ms).toFixed(0).padStart(7)} ops/sec   answer=${answer}`,
);
