/**
 * WHERE DOES A 2+-HOP `collect` SPEND 1,476 ms, when materializing the SAME 1,280,000 rows costs 187?
 *
 * Item 1829 priced `collect` as the last of its six modifiers and left it on the byte-identity
 * refusal ("its order IS its answer"), which item 2404's owner ruling retired. The route probe says
 * it has a rung at ONE hop (`hopAggregate`) and NOTHING at two or more.
 *
 * PROFILE BEFORE BUILDING, because the ROUTE is only one candidate. The `where` modifier - which
 * disqualifies every chain rung - materializes the same 1,280,000 rows through the general matcher
 * in ~728 ms (item 2410's grid). `collect` costs 1,476. So AT MOST HALF of the gap is the missing
 * rung, and the other half is something else. Guessing which would be item 2408's and 2409's mistake
 * a third time.
 *
 * Node, not bun: `node:inspector` gives a real CPU profile and `@lenke/*` resolve to the ESM dist.
 *
 *     node collectprof-2413.mjs
 *     SHAPE=rows HOPS=3 node collectprof-2413.mjs
 */
import { Session } from 'node:inspector';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const HOPS = Number(process.env.HOPS ?? 3);
const SHAPE = process.env.SHAPE ?? 'collect';
const REPS = Number(process.env.REPS ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX - CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const names = ['a', 'b', 'c', 'd', 'e'];
const vars = names.slice(0, HOPS + 1);
const far = vars[HOPS];
const pattern = vars.map((v) => `(${v}:T)`).join('-[:E]->');

const RETURNS = {
  collect: `collect(${far}.n)`,
  // THE FLOOR, and it takes a RUNG, so its profile is what the fast route looks like.
  rows: `${far}.n`,
  // The general matcher over the SAME rows: a clause `WHERE` disqualifies every chain rung, so this
  // separates "no rung" from "aggregation machinery".
  rowsgeneric: `${far}.n`,
  countx: `count(${far}.n)`,
};

const where = SHAPE === 'rowsgeneric' ? ` WHERE ${vars[0]}.n >= 0` : '';
const text = `MATCH ${pattern}${where} RETURN ${RETURNS[SHAPE]} AS x`;

// One warm pass so the profile is steady-state rather than the JIT tiering up.
query(g, text, {});

const session = new Session();

session.connect();

const post = (method, params) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });

await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 200 });
await post('Profiler.start');

let answer = 0;

for (let r = 0; r < REPS; r += 1) {
  const out = query(g, text, {});
  const only = out.length === 1 ? out[0].x : undefined;

  answer = Array.isArray(only) ? only.length : out.length;
}

const { profile } = await post('Profiler.stop');

session.disconnect();

// Self time per frame, which is what a "where does it go" question wants. The total is the sum of
// the deltas rather than the wall clock, so the percentages are of PROFILED time.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;

for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i] ?? 0;
  const node = byId.get(profile.samples[i]);

  if (node === undefined) {
    continue;
  }

  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.split('/').pop() ?? url;
  const key = `${functionName === '' ? '(anonymous)' : functionName}  ${file}:${lineNumber + 1}`;

  self.set(key, (self.get(key) ?? 0) + dt);
  total += dt;
}

console.log(`# ${SHAPE}  hops=${HOPS}  N=${NODES}  F=${FANOUT}  reps=${REPS}  answer=${answer}`);
console.log(`# ${text}`);
console.log(`# profiled ${(total / 1000).toFixed(0)} ms total\n`);

for (const [key, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
  const ms = us / 1000;

  console.log(
    `  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${ms.toFixed(0).padStart(6)} ms  ${key}`,
  );
}
