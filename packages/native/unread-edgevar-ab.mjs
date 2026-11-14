/**
 * PRE/POST FOR THE ORDERED OPTIONAL-HOP RUNG (item 1849).
 *
 * `detectOptionalHopProjection` gates on `plainRowProjection`, which refuses an `orderBy`, so
 * adding an `ORDER BY` to an OPTIONAL hop dropped the whole rung.
 *
 * ⚠️ THE TWO SIBLING CLIFFS ARE CONTROLS, NOT TARGETS, and they are in the table precisely so this
 * item cannot be read as having fixed them. An edge VARIABLE and an outer clause `WHERE` each cost
 * ~9.4x on the same rung and are left open; if either moves here, the change is doing something
 * other than what its comment says.
 *
 * ⚠️ ONE SHAPE PER PROCESS; arms asserted by `optionalOrderedProjection` in the built dist.
 *
 *     bun optional-ordered-ab.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const TARGETS = ['hop-projection'];
const EXTRA = [];
const srcOf = (n) => `${ROOT}/packages/gql/src/executor/${n}.ts`;
const postOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1850-post-${n}.ts`;
const preOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1850-pre-${n}.ts`;
const ALL = [...TARGETS, ...EXTRA];
const MARKER = 'returnReadsName';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'unread edge var': 'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.n AS x, b.n AS y',
  'unread edge var + ORDER BY':
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.n AS x, b.n AS y ORDER BY x, y',
  'unread edge var, union':
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E|F]->(b:T) RETURN a.n AS x, b.n AS y',
  // ⚠️ THE READ SPELLING MUST NOT MOVE: it still declines by design, because the walk does not
  // bind the edge. If this got faster, the rung would be answering a query it cannot answer.
  'CONTROL READ edge var': 'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.n AS x, e.w AS y',
  'CONTROL read only in ORDER BY':
    'MATCH (a:T) OPTIONAL MATCH (a)-[e:E]->(b:T) RETURN a.n AS x, b.n AS y ORDER BY e.w',
  'CONTROL optional no edge var':
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.n AS x, b.n AS y',
  'CONTROL plain hop edge var': 'MATCH (a:T)-[e:E]->(b:T) RETURN a.n AS x, b.n AS y',
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
    g.addEdge({ id: 'e' + (e++), from: g.getVertexById(String(i + 1)), to: g.getVertexById(String(((i * 7 + 3 + h * 2654435761) % N) + 1)), labels: [h % 2 === 0 ? 'E' : 'F'], properties: { w: e % 7 } });
  }
}
const Q = ${JSON.stringify(text)};
const s = [];
let digest = null;
for (let r = 0; r < ${REPS}; r += 1) {
  const t0 = performance.now();
  const out = query(g, Q);
  s.push(performance.now() - t0);
  // ⚠️ THE FIRST 200 ROWS IN ORDER, not a sorted set: this rung's whole claim is that it produces
  // the SAME ORDER as the general path, so a set digest would miss the bug it could introduce.
  const d = out.length + '|' + out.slice(0, 200).map((x) => Object.values(x).map(String).join('/')).join(',');
  if (digest === null) { digest = d; } else if (digest !== d) { throw new Error('answer moved between reps'); }
}
const kept = s.slice(3).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ ms: kept[Math.floor(kept.length / 2)], digest }));
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
  for (const n of ALL) {
    copyFileSync(which === 'PRE' ? preOf(n) : postOf(n), srcOf(n));
  }

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

for (const n of ALL) {
  copyFileSync(srcOf(n), postOf(n));
  writeFileSync(
    preOf(n),
    execFileSync('git', ['show', `HEAD:packages/gql/src/executor/${n}.ts`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

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
  for (const n of ALL) {
    copyFileSync(postOf(n), srcOf(n));
  }

  build();
}

console.log(`\n# unread-edgevar-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  const same = rounds[0].PRE[name].digest === rounds[0].POST[name].digest;

  console.log(
    `${name.padEnd(36)} PRE ${pre.toFixed(2).padStart(8)} ms   POST ${post
      .toFixed(2)
      .padStart(8)} ms   ${(pre / post).toFixed(2)}x${same ? '' : '   ⚠️ ROWS OR ORDER DIFFER'}`,
  );
}
