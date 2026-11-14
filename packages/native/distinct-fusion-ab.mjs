/**
 * PRE/POST FOR THE FUSED CHAIN `DISTINCT` (item 1843).
 *
 * The lever: `detectChainProjection` used to build every undeduped row and call `distinctRows`
 * afterwards — 125,000 rows materialized to return 8. The change dedupes INSIDE the walk for a
 * ONE-COLUMN projection, so a duplicate never becomes a row object.
 *
 * ⚠️ ONE SHAPE PER PROCESS, which this session has now been bitten by three times (items 1828,
 * 1832, and item 1842, where arms sharing a process manufactured a 2.1x that did not exist). Every
 * cell below is its own `bun` child running one query text; nothing in a child ever sees a second
 * shape.
 *
 * ⚠️ THE ARMS ARE ASSERTED IN THE BUILT DIST, not assumed from the file on disk. `emitRow` is the
 * POST arm's marker: it must appear in `packages/gql/dist` for POST and be ABSENT for PRE. An A/B
 * whose arms are not asserted cannot tell a null from a mistake, and CLAUDE.md records a run where
 * the "after" reading was the "before" code.
 *
 * ⚠️ TWO CONTROLS THE CHANGE CANNOT REACH, because a change that redistributes call sites flatters
 * itself (item 762) and the giveaway is a control moving more than the target:
 *   - `undeduped`  — the same walk with no DISTINCT at all. Shares `emitRow`'s new branch, so it
 *                    prices what the branch costs the common path.
 *   - `twocol`     — a two-column DISTINCT, which the fusion REFUSES. Same rung, same walk, old
 *                    materialize-then-dedupe tail.
 *   - `countonly`  — a different rung entirely.
 *
 * ⚠️ ALTERNATED ROUNDS. Arms run PRE,POST then POST,PRE then PRE,POST so a machine that drifts
 * during the run cannot hand either arm the quiet half.
 *
 *     bun distinct-fusion-ab.mjs
 *     ROUNDS=2 REPS=5 bun distinct-fusion-ab.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
// ⚠️ BOTH RUNGS, because the fusion landed in both and a PRE arm that reverted only one would
// measure a half-reverted engine. `chain-projection` serves 3+ segments, `hop2-projection` two.
const TARGETS = ['chain-projection', 'hop2-projection'];
const srcOf = (n) => `${ROOT}/packages/gql/src/executor/${n}.ts`;
const postOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1843-post-${n}.ts`;
const preOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1843-pre-${n}.ts`;
const MARKER = 'emitRow';

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);

// ⚠️ SEGMENTS ARE COUNTED BY ARROWS, and the first run of this A/B mislabelled them by one:
// `(a)->(b)->(c)` is TWO segments and goes to `hop2-projection`, which `detectChainProjection`
// refuses (it requires three). The 1.00x that row first reported was not a null result — it was
// an unfused rung being measured against itself.
const SHAPES = {
  'distinct 2seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT c.n AS x',
  'distinct 3seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN DISTINCT d.n AS x',
  'distinct 2seg ordered':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT c.n AS x ORDER BY x',
  'CONTROL undeduped 2seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.n AS x',
  'CONTROL undeduped 3seg': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x',
  'CONTROL twocol': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN DISTINCT c.n AS x, c.m AS y',
  'CONTROL countonly': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN count(*) AS x',
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const markerCount = () => {
  const dist = readFileSync(`${ROOT}/packages/gql/dist/esm/index.mjs`, 'utf8');

  return dist.split(MARKER).length - 1;
};

const run = (text) => {
  const src = `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const N = ${NODES}, F = ${FANOUT};
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8, m: i % 3 } });
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
  // ⚠️ THE ANSWER GUARD. A fused dedupe that dropped or invented rows would be the fastest arm
  // in this table; the row count is compared ACROSS arms by the driver.
  if (rows === -1) { rows = out.length; } else if (rows !== out.length) { throw new Error('row count moved between reps'); }
}
const kept = s.slice(2).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ median: kept[Math.floor(kept.length / 2)], rows }));
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
  for (const n of TARGETS) {
    copyFileSync(which === 'PRE' ? preOf(n) : postOf(n), srcOf(n));
  }

  build();

  const n = markerCount();
  const ok = which === 'POST' ? n > 0 : n === 0;

  if (!ok) {
    throw new Error(`ARM ASSERTION FAILED: ${which} dist has ${n} '${MARKER}'`);
  }

  const out = {};

  for (const [name, text] of Object.entries(SHAPES)) {
    out[name] = run(text);
  }

  return out;
};

const { writeFileSync } = await import('node:fs');

for (const n of TARGETS) {
  copyFileSync(srcOf(n), postOf(n));
  // The PRE file is HEAD's copy, written through node rather than a shell redirect (noclobber).
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
  for (const n of TARGETS) {
    copyFileSync(postOf(n), srcOf(n));
  }

  build();
}

console.log(
  `\n# distinct-fusion-ab — ${ROUNDS} alternated rounds, reps=${REPS}, N=${NODES} F=${FANOUT}`,
);
console.log('# min of each arm across rounds; rows asserted equal across arms\n');

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].median));
  const post = Math.min(...rounds.map((x) => x.POST[name].median));
  const rowsPre = rounds[0].PRE[name].rows;
  const rowsPost = rounds[0].POST[name].rows;
  const same = rowsPre === rowsPost ? '' : `  ⚠️ ROWS DIFFER ${rowsPre} vs ${rowsPost}`;

  console.log(
    `${name.padEnd(20)} PRE ${pre.toFixed(1).padStart(7)} ms   POST ${post
      .toFixed(1)
      .padStart(7)} ms   ${(pre / post).toFixed(2)}x   rows ${rowsPost}${same}`,
  );
}
