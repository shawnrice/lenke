/**
 * PRE/POST FOR THE DEDUPED K-HOP COUNT (item 1855).
 *
 * `distinctHopCount` answered ONE hop from an index key count; two hops reached nothing and fell
 * to the traverser pipeline. `dedupedHopChainCount` expands a SET per level instead.
 *
 * ⚠️ ONE SHAPE PER PROCESS; arms asserted by a ROUTE probe (does `countShortcut` claim the
 * two-hop shape?) rather than a dist grep, for item 1852's reason: a marker in a comment is
 * stripped by the bundler.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/index.ts`;
const POST = `${ROOT}/crates/lenke-engine/target/pristine-1856-post.ts`;
const PRE = `${ROOT}/crates/lenke-engine/target/pristine-1856-pre.ts`;

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const REPS = Number(process.env.REPS ?? 7);
const NODES = Number(process.env.NODES ?? 50000);
const FANOUT = Number(process.env.FANOUT ?? 4);

const SHAPES = {
  'hop1 .by() modulator': "traversal(V(), out('E'), groupCount().by('k'))",
  'hop2 .by() modulator': "traversal(V(), out('E'), out('E'), groupCount().by('k'))",
  'hop3 .by() modulator': "traversal(V(), out('E'), out('E'), out('E'), groupCount().by('k'))",
  // ⚠️ THE CONFIG SPELLING IS THE TARGET TO CONVERGE ON, not a control: it already took the fused
  // walk, so it must NOT move — and the modulator spelling must come to meet it.
  'TARGET hop1 {by} config': "traversal(V(), out('E'), groupCount({ by: 'k' }))",
  'TARGET hop2 {by} config': "traversal(V(), out('E'), out('E'), groupCount({ by: 'k' }))",
  'CONTROL scan .by()': "traversal(V(), groupCount().by('k'))",
  'CONTROL hop2 values': "traversal(V(), out('E'), out('E'), values('k'))",
};

const build = () => execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

/**
 * ⚠️ THE ARM IS ASSERTED BY TIMING A DISCRIMINATING FIXTURE, because the thing that changed is a
 * private gate (`asGroupCountByKey`) with no exported handle and no new identifier to grep for —
 * and a marker in a comment is stripped by the bundler (item 1845). The first version of this
 * check used 4,000 vertices and a 30 ms threshold, which BOTH arms passed; at 20,000 x fanout 4
 * the two routes are ~20x apart, so the separation is unambiguous rather than a judgement call.
 */
const claimsTwoHop = () => {
  const out = execFileSync(
    'bun',
    [
      '--input-type=module',
      '-e',
      "import { Graph } from '@lenke/core';\nimport { V, groupCount, out, toArray, traversal } from './src/index.ts';\nconst N = 20000;\nconst g = new Graph();\nfor (let i = 0; i < N; i += 1) { g.addVertex({ id: 'v' + i, labels: ['T'], properties: { k: i % 3 } }); }\nlet e = 0;\nfor (let h = 0; h < 4; h += 1) { for (let i = 0; i < N; i += 1) { g.addEdge({ id: 'e' + (e++), from: g.getVertexById('v' + i), to: g.getVertexById('v' + ((i * 7 + 3 + h) % N)), labels: ['E'] }); } }\nconst tr = traversal(V(), out('E'), out('E'), groupCount().by('k'));\ntoArray(tr, g);\nconst t0 = performance.now();\ntoArray(tr, g);\nprocess.stdout.write(String(performance.now() - t0));",
    ],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return Number(out) < 40;
};

const run = (src) => {
  const code = `
import { Graph } from '@lenke/core';
import { V, count, dedupe, groupCount, out, toArray, traversal, values } from '@lenke/gremlin';
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
  const first = outv[0];\n  const d = outv.length + '|' + (first instanceof Map ? JSON.stringify([...first]) : String(first)).slice(0, 120);
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
  execFileSync('git', ['show', 'HEAD:packages/gremlin/src/executor/index.ts'], {
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

console.log(`\n# groupcount-spelling-ab — ${ROUNDS} alternated rounds, N=${NODES} F=${FANOUT}\n`);

for (const name of Object.keys(SHAPES)) {
  const pre = Math.min(...rounds.map((x) => x.PRE[name].ms));
  const post = Math.min(...rounds.map((x) => x.POST[name].ms));
  const same = rounds[0].PRE[name].digest === rounds[0].POST[name].digest;

  console.log(
    `${name.padEnd(28)} PRE ${pre.toFixed(2).padStart(9)} ms   POST ${post
      .toFixed(2)
      .padStart(9)} ms   ${(pre / post).toFixed(2)}x${same ? '' : '   ⚠️ ANSWER DIFFERS'}`,
  );
}
