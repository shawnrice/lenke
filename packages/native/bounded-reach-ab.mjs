/**
 * PRE/POST FOR THE BOUNDED REACHABILITY RUNG (item 1848).
 *
 * `detectReachableShortcut` required `q.max === null`, so an UNBOUNDED `->+` got a BFS over the
 * reached set while a BOUNDED `{1,3}` was sent to path enumeration.
 *
 * TWO CONTROLS THAT CANNOT MOVE, and they are different kinds:
 *   - `ACYCLIC {1,3}` is REFUSED by the gate on purpose (ACYCLIC genuinely diverges from set
 *     reachability — on one node with a self-loop it answers 0 where a BFS answers 1), so it keeps
 *     the enumeration path. If it moves, the gate is admitting something it must not.
 *   - unbounded `{1,}` ALREADY took the rung before this change, so it prices whether widening the
 *     gate perturbed the arm that was already there.
 *   - a plain 2-hop chain reaches a different rung entirely.
 *
 * ONE SHAPE PER PROCESS; arms asserted by `maxDepth` in the built dist.
 *
 *     bun bounded-reach-ab.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/reachability.ts`;
const POST = `${ROOT}/crates/lenke-engine/target/pristine-1848-post.ts`;
const PRE = `${ROOT}/crates/lenke-engine/target/pristine-1848-pre.ts`;
const MARKER = 'maxDepth';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const NODES = Number(process.env.NODES ?? 3000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'bounded {1,3} DISTINCT': 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x',
  'bounded {1,2} DISTINCT': 'MATCH (a:T)-[:E]->{1,2}(b:T) RETURN DISTINCT b.n AS x',
  'bounded TRAIL {1,3}': 'MATCH TRAIL (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x',
  'bounded count(DISTINCT)': 'MATCH (a:T)-[:E]->{1,3}(b:T) RETURN count(DISTINCT b) AS x',
  'CONTROL ACYCLIC {1,3}': 'MATCH ACYCLIC (a:T)-[:E]->{1,3}(b:T) RETURN DISTINCT b.n AS x',
  'CONTROL unbounded {1,}': 'MATCH (a:T)-[:E]->{1,}(b:T) RETURN DISTINCT b.n AS x',
  'CONTROL plain 2-hop': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.n AS x',
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerLines = () => {
  const r = spawnSync('grep', ['-c', MARKER, `${ROOT}/packages/gql/dist/esm/index.mjs`], {
    encoding: 'utf8',
  });

  return Number((r.stdout ?? '0').trim());
};

const run = (text) => {
  const src = `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const N = ${NODES}, F = ${FANOUT};
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
}
let e = 0;
for (let h = 0; h < F; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({ id: 'e' + (e++), from: g.getVertexById(String(i + 1)), to: g.getVertexById(String(((i * 7 + 3 + h * 2654435761) % N) + 1)), labels: ['E'] });
  }
}
const Q = ${JSON.stringify(text)};
const s = [];
let digest = null;
for (let r = 0; r < ${REPS}; r += 1) {
  const t0 = performance.now();
  const out = query(g, Q);
  s.push(performance.now() - t0);
  const d = out.map((x) => Object.values(x).map(String).join('/')).sort().join(',');
  if (digest === null) { digest = d; } else if (digest !== d) { throw new Error('answer moved between reps'); }
}
const kept = s.slice(2).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ ms: kept[Math.floor(kept.length / 2)], digest }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

const arm = (which) => {
  copyFileSync(which === 'PRE' ? PRE : POST, SRC);
  build();

  const n = markerLines();

  if (which === 'POST' ? n === 0 : n > 0) {
    throw new Error(`ARM ASSERTION FAILED: ${which} dist has ${n} lines with '${MARKER}'`);
  }

  const out = {};

  for (const [name, text] of Object.entries(SHAPES)) {
    out[name] = run(text);
  }

  return out;
};

copyFileSync(SRC, POST);
writeFileSync(
  PRE,
  execFileSync('git', ['show', 'HEAD:packages/gql/src/executor/reachability.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }),
);

const rounds = [];

try {
  for (let r = 0; r < ROUNDS; r += 1) {
    const order = r % 2 === 0 ? ['PRE', 'POST'] : ['POST', 'PRE'];
    const got = {};

    for (const which of order) {
      got[which] = arm(which);
    }

    rounds.push(got);
    console.log(`# round ${r} done (${order.join(' then ')})`);
  }
} finally {
  copyFileSync(POST, SRC);
  build();
}

console.log(`\n# bounded-reach-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  // THE ANSWER GUARD IS CROSS-ARM: a rung that returned different rows would be the fastest
  // thing in this table.
  const same = rounds[0].PRE[name].digest === rounds[0].POST[name].digest;

  console.log(
    `${name.padEnd(24)} PRE ${pre.toFixed(2).padStart(8)} ms   POST ${post
      .toFixed(2)
      .padStart(8)} ms   ${(pre / post).toFixed(2)}x${same ? '' : '   ANSWER DIFFERS'}`,
  );
}
