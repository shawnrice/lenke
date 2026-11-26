/**
 * PRE/POST FOR THE COMMA-CHAIN SPLICE (item 1844).
 *
 * `MATCH (a)-[:E]->(b), (b)-[:E]->(c)` is the same walk as the arrow spelling, and used to go to
 * the general multi-pattern path while the arrow took the chain rung.
 *
 * THE ARROW SPELLING IS BOTH AN ARM AND THE TARGET. The claim is not just "faster" but
 * "converges on the spelling it is equivalent to", so the table prints the arrow's own time beside
 * each comma cell. A comma cell that got faster but still sat well above its arrow twin would mean
 * the splice fired and something else declined.
 *
 * ONE SHAPE PER PROCESS (item 762, and items 1828/1832/1842 in this session). Each cell is its
 * own `bun` child.
 *
 * ARMS ASSERTED in the built dist via `spliceChainedPatterns`, which exists only in POST.
 *
 * THE CONTROL IS A TRUE PRODUCT — two patterns sharing no variable, which the rewrite must
 * refuse. If it moves, the rewrite is firing where it should not.
 *
 *     bun splice-ab.mjs
 *     ROUNDS=2 NODES=800 bun splice-ab.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/rewrites.ts`;
const POST = `${ROOT}/crates/lenke-engine/target/pristine-1844-post.ts`;
const PRE = `${ROOT}/crates/lenke-engine/target/pristine-1844-pre.ts`;
const MARKER = 'spliceChainedPatterns';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 5);
const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'comma 2 patterns': 'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN a.n AS x, c.n AS y',
  'comma 3 patterns':
    'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T), (c)-[:E]->(d:T) RETURN a.n AS x, d.n AS y',
  'comma + DISTINCT': 'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN DISTINCT c.n AS x',
  'comma + count': 'MATCH (a:T)-[:E]->(b:T), (b)-[:E]->(c:T) RETURN count(*) AS c',
  'ARROW twin (2)': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN a.n AS x, c.n AS y',
  'CONTROL product': 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:E]->(d:T) RETURN b.n AS x, d.n AS y',
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerInDist = () => {
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
let rows = -1;
for (let r = 0; r < ${REPS}; r += 1) {
  const t0 = performance.now();
  const out = query(g, Q);
  s.push(performance.now() - t0);
  if (rows === -1) { rows = out.length; } else if (rows !== out.length) { throw new Error('rows moved'); }
}
const kept = s.slice(1).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ median: kept[Math.floor(kept.length / 2)], rows }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
};

const arm = (which) => {
  copyFileSync(which === 'PRE' ? PRE : POST, SRC);
  build();

  const n = markerInDist();

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
  execFileSync('git', ['show', 'HEAD:packages/gql/src/executor/rewrites.ts'], {
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

console.log(`\n# splice-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].median));
  const post = Math.min(...rounds.map((x) => x.POST[name].median));
  const rPre = rounds[0].PRE[name].rows;
  const rPost = rounds[0].POST[name].rows;

  const warn = rPre === rPost ? '' : `  ROWS DIFFER ${rPre} vs ${rPost}`;

  console.log(
    `${name.padEnd(20)} PRE ${pre.toFixed(1).padStart(8)} ms   POST ${post
      .toFixed(1)
      .padStart(8)} ms   ${(pre / post).toFixed(2)}x   rows ${rPost}${warn}`,
  );
}
