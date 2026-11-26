/**
 * PRE/POST FOR THE ORDERED OPTIONAL-HOP RUNG (item 1849).
 *
 * `detectOptionalHopProjection` gates on `plainRowProjection`, which refuses an `orderBy`, so
 * adding an `ORDER BY` to an OPTIONAL hop dropped the whole rung.
 *
 * THE TWO SIBLING CLIFFS ARE CONTROLS, NOT TARGETS, and they are in the table precisely so this
 * item cannot be read as having fixed them. An edge VARIABLE and an outer clause `WHERE` each cost
 * ~9.4x on the same rung and are left open; if either moves here, the change is doing something
 * other than what its comment says.
 *
 * ONE SHAPE PER PROCESS; arms asserted by `optionalOrderedProjection` in the built dist.
 *
 *     bun optional-ordered-ab.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const TARGETS = ['chain-projection', 'hop2-projection', 'hop-projection'];
const EXTRA = [];
const srcOf = (n) => `${ROOT}/packages/gql/src/executor/${n}.ts`;
const postOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1852-post-${n}.ts`;
const preOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1852-pre-${n}.ts`;
const ALL = [...TARGETS, ...EXTRA];

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  // SMALL LIMIT: the regime `boundedTopRows`' heap is for ((skip+limit)*16 <= rows).
  'chain3 topk LIMIT 10':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x ORDER BY x LIMIT 10',
  'chain2 topk LIMIT 10': 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.n AS x ORDER BY x LIMIT 10',
  // LARGE LIMIT: past the heap's crossover, so this is the cell where admitting the window
  // could LOSE rather than win — the existing route assertion's stated fear.
  'chain3 topk LIMIT 100000':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x ORDER BY x LIMIT 100000',
  'chain3 sorted SKIP 5':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x ORDER BY x SKIP 5',
  'optional topk':
    'MATCH (a:T) OPTIONAL MATCH (a)-[:E]->(b:T) RETURN a.n AS x, b.n AS y ORDER BY x LIMIT 10',
  'CONTROL chain3 sort, no window':
    'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x ORDER BY x',
  'CONTROL hop topk (already had it)':
    'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x LIMIT 10',
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

/**
 * THE ARM IS ASSERTED BY ROUTE, NOT BY A DIST GREP, and the first version of this file is why:
 * this change REMOVES a refusal, so there is no new identifier to look for, and the comment I
 * first used as a marker was stripped by the bundler (item 1845's trap, second occurrence). Asking
 * the compiler which rung claims a windowed sort is both robust and exactly the property under
 * test.
 */
const takesWindowedRung = () => {
  const out = execFileSync(
    'bun',
    [
      '--input-type=module',
      '-e',
      "import { compileLinear } from './src/executor/rewrites.ts';\nimport { parse } from './src/parser.ts';\nconst q = parse('MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T)-[:E]->(d:T) RETURN d.n AS x ORDER BY x LIMIT 10');\nconst cl = compileLinear(q.parts[0]);\nprocess.stdout.write(Object.entries(cl).filter(([, v]) => typeof v === 'function').map(([k]) => k).join(','));",
    ],
    { cwd: `${ROOT}/packages/gql`, encoding: 'utf8' },
  );

  return out.includes('chainOrderedProjection');
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
  // THE FIRST 200 ROWS IN ORDER, not a sorted set: this rung's whole claim is that it produces
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

  const takes = takesWindowedRung();

  if (which === 'POST' ? !takes : takes) {
    throw new Error(
      `ARM ASSERTION FAILED: ${which} ${takes ? 'DOES' : 'does NOT'} route a windowed sort to the chain rung`,
    );
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

console.log(`\n# windowed-sort-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  const same = rounds[0].PRE[name].digest === rounds[0].POST[name].digest;

  console.log(
    `${name.padEnd(36)} PRE ${pre.toFixed(2).padStart(8)} ms   POST ${post
      .toFixed(2)
      .padStart(8)} ms   ${(pre / post).toFixed(2)}x${same ? '' : '   ROWS OR ORDER DIFFER'}`,
  );
}
