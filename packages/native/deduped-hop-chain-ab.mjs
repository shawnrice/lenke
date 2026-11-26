/**
 * PRE/POST FOR THE DEDUPED K-HOP COUNT (item 1855).
 *
 * `distinctHopCount` answered ONE hop from an index key count; two hops reached nothing and fell
 * to the traverser pipeline. `dedupedHopChainCount` expands a SET per level instead.
 *
 * ONE SHAPE PER PROCESS; arms asserted by a ROUTE probe (does `countShortcut` claim the
 * two-hop shape?) rather than a dist grep, for item 1852's reason: a marker in a comment is
 * stripped by the bundler.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/count-shortcut.ts`;
const POST = `${ROOT}/crates/lenke-engine/target/pristine-1855-post.ts`;
const PRE = `${ROOT}/crates/lenke-engine/target/pristine-1855-pre.ts`;

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'dedupe.count 2 hops': "traversal(V(), out('E'), out('E'), dedupe(), count())",
  'dedupe.count 3 hops': "traversal(V(), out('E'), out('E'), out('E'), dedupe(), count())",
  'dedupe.count 4 hops':
    "traversal(V(), out('E'), out('E'), out('E'), out('E'), dedupe(), count())",
  'dedupe.count untyped 2': 'traversal(V(), out(), out(), dedupe(), count())',
  'CONTROL dedupe.count 1 hop': "traversal(V(), out('E'), dedupe(), count())",
  'CONTROL plain count 2 hops': "traversal(V(), out('E'), out('E'), count())",
  'CONTROL values 2 hops': "traversal(V(), out('E'), out('E'), values('k'))",
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

const claimsTwoHop = () => {
  const out = execFileSync(
    'bun',
    [
      '--input-type=module',
      '-e',
      "import { Graph } from '@lenke/core';\nimport { V, count, dedupe, out, traversal } from './src/index.ts';\nimport { countShortcut } from './src/executor/count-shortcut.ts';\nconst g = new Graph();\ng.addVertex({ id: 'a', labels: ['T'], properties: {} });\ng.addVertex({ id: 'b', labels: ['T'], properties: {} });\ng.addEdge({ id: 'e0', from: g.getVertexById('a'), to: g.getVertexById('b'), labels: ['E'] });\nconst r = countShortcut(traversal(V(), out('E'), out('E'), dedupe(), count()), g);\nprocess.stdout.write(r === undefined ? 'declined' : 'claimed');",
    ],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return out.includes('claimed');
};

const run = (src) => {
  const code = `
import { Graph } from '@lenke/core';
import { V, count, dedupe, out, toArray, traversal, values } from '@lenke/gremlin';
const N = ${NODES}, F = ${FANOUT};
const g = new Graph();
for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: 'v' + i, labels: ['T'], properties: { k: i % 7 } });
}
let e = 0;
for (let h = 0; h < F; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({ id: 'e' + (e++), from: g.getVertexById('v' + i), to: g.getVertexById('v' + ((i * 7 + 3 + h * 2654435761) % N)), labels: ['E'] });
  }
}
const tr = ${src};
const s = [];
let digest = null;
for (let r = 0; r < ${REPS}; r += 1) {
  const t0 = performance.now();
  const outv = toArray(tr, g);
  s.push(performance.now() - t0);
  const d = outv.length + '|' + String(outv[0]).slice(0, 40);
  if (digest === null) { digest = d; } else if (digest !== d) { throw new Error('answer moved'); }
}
const kept = s.slice(2).sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ ms: kept[Math.floor(kept.length / 2)], digest }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', code], {
      cwd: `${ROOT}/packages/native`,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }),
  );
};

const arm = (which) => {
  copyFileSync(which === 'PRE' ? PRE : POST, SRC);
  build();

  const claims = claimsTwoHop();

  if (which === 'POST' ? !claims : claims) {
    throw new Error(
      `ARM ASSERTION FAILED: ${which} ${claims ? 'claims' : 'declines'} the two-hop shape`,
    );
  }

  const out = {};

  for (const [name, src] of Object.entries(SHAPES)) {
    out[name] = run(src);
  }

  return out;
};

copyFileSync(SRC, POST);
writeFileSync(
  PRE,
  execFileSync('git', ['show', 'HEAD:packages/gremlin/src/executor/count-shortcut.ts'], {
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

console.log(`\n# deduped-hop-chain-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  const same = rounds[0].PRE[name].digest === rounds[0].POST[name].digest;

  console.log(
    `${name.padEnd(28)} PRE ${pre.toFixed(2).padStart(9)} ms   POST ${post
      .toFixed(2)
      .padStart(9)} ms   ${(pre / post).toFixed(2)}x${same ? '' : '   ANSWER DIFFERS'}`,
  );
}
