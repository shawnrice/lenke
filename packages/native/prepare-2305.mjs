/**
 * ⚠️⚠️ **WHAT DOES `prepare()` SAVE ON A WARM, CACHED QUERY? (item 2305)**
 *
 * `@lenke/gql` exports `prepare(text)` — *"Parse + compile a query string into a reusable Plan. Do this
 * once for a hot query, then call the plan with just (graph, params)"*. 🔑 The guide has a rule for
 * hoisting a GREMLIN traversal (18%) and says nothing about the GQL equivalent.
 *
 * ⚠️ The honest question is NOT "does it beat an interpolating caller" — item 1502 already shipped
 * `normalizeLiterals` for that, 1.46-2.07x. It is: **on a cache HIT, with a constant text and params,
 * what is left to save?** `query()` still has to hash the text, hit the parse cache, and look the plan up
 * in a `WeakMap` on every call.
 *
 * ✅ INNER-ITERATION CALIBRATION, because these arms are microseconds and items 2302/2303 cost two
 * published numbers to a single-call timer. One shape per process.
 */
import { Graph } from '@lenke/core';
import { prepare, query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 20_000);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 25);
const SHAPE = process.env.SHAPE ?? 'point';
const ARM = process.env.ARM ?? 'query';

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

/* Indexed, because an unindexed scan would bury the per-call overhead this probe is about. */
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

const QUERIES = {
  point: 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s',
  twohop: 'MATCH (u:User)-[:FOLLOWS]->()-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c',
  count: 'MATCH (u:User) RETURN count(*) AS c',
};

const text = QUERIES[SHAPE];
const params = { n: 'user7' };

/* The prepared plan is built ONCE, outside everything timed — which is the whole point of the API. */
const plan = prepare(text);
const run = ARM === 'prepared' ? () => plan(g, params) : () => query(g, text, params);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let w = 0; w < 500; w += 1) {
  run();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 4_000_000) {
    break;
  }

  inner *= 2;
}

const ts = [];
let answer;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  for (let i = 0; i < inner; i += 1) {
    [answer] = run();
  }

  ts.push((performance.now() - t) / inner);
}

const ms = med(ts);

console.log(
  `  SHAPE=${SHAPE.padEnd(7)} ARM=${ARM.padEnd(8)} ${(ms * 1e6).toFixed(0).padStart(7)} ns/call   inner=${String(inner).padStart(8)}   answer=${JSON.stringify(answer)}`,
);
