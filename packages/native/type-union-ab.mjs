/**
 * PRE/POST FOR THE TYPE-UNION HOP ON THE TWO-SEGMENT RUNG (item 1846).
 *
 * `hopOf` models a hop as ONE `type: string`, so `-[:E|F]->` declined `detectHop2Projection` and a
 * chain of alternations fell to the general matcher. `walkUnion` takes it.
 *
 * ⚠️ THE SINGLE-TYPE CONTROL IS THE REASON THIS FILE EXISTS. `executor-edits-perturb` records a new
 * walk variant costing UNRELATED rows up to 16% five times over, and a cross-run comparison during
 * the build read the single-type row at 169 ns/row against an earlier 102 — which is either a real
 * regression or two different processes. Only a PRE/POST with the control in it can tell, so the
 * control is a first-class arm here and not an afterthought.
 *
 * ⚠️ ONE SHAPE PER PROCESS (item 762, and three times in this session alone).
 * ⚠️ ARMS ASSERTED by `walkUnion` in the built dist, which exists only in POST.
 *
 *     bun type-union-ab.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/hop2-projection.ts`;
const POST = `${ROOT}/crates/lenke-engine/target/pristine-1846-post.ts`;
const PRE = `${ROOT}/crates/lenke-engine/target/pristine-1846-pre.ts`;
const MARKER = 'walkUnion';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const NODES = Number(process.env.NODES ?? 3000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'union 2seg': 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN c.n AS x',
  'union 2seg DISTINCT': 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T) RETURN DISTINCT c.n AS x',
  'CONTROL single 2seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.n AS x',
  'CONTROL single 1seg': 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
  'CONTROL single 3seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x',
  'CONTROL union 3seg': 'MATCH (a:T)-[:E|F]->(b:T)-[:E|F]->(c:T)-[:E|F]->(d:T) RETURN d.n AS x',
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
    g.addEdge({ id: 'e' + (e++), from: g.getVertexById(String(i + 1)), to: g.getVertexById(String(((i * 7 + 3 + h * 2654435761) % N) + 1)), labels: [h % 2 === 0 ? 'E' : 'F'] });
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
const kept = s.slice(3).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ ms: kept[Math.floor(kept.length / 2)], rows }));
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
  execFileSync('git', ['show', 'HEAD:packages/gql/src/executor/hop2-projection.ts'], {
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

console.log(`\n# type-union-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  const { rows } = rounds[0].POST[name];
  const rowsPre = rounds[0].PRE[name].rows;
  const warn = rows === rowsPre ? '' : `  ⚠️ ROWS DIFFER ${rowsPre} vs ${rows}`;
  const perRow = (ms) => ((ms * 1e6) / rows).toFixed(0);

  console.log(
    `${name.padEnd(22)} PRE ${pre.toFixed(1).padStart(7)} ms (${perRow(pre).padStart(5)} ns/row)   ` +
      `POST ${post.toFixed(1).padStart(7)} ms (${perRow(post).padStart(5)} ns/row)   ` +
      `${(pre / post).toFixed(2)}x${warn}`,
  );
}
