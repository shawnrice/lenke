/**
 * DOES THE ONE-HOP CSR WALK EARN ITS PLACE — WARM AND COLD, SMALL AND LARGE? (item 1889)
 *
 * ⚠️ THIS ARM'S TRADE-OFF IS THE WHOLE QUESTION, and `hop-values.ts` priced it at items 1693/1694
 * without settling it: the CSR is keyed on `topologyVersion`, so the FIRST query after any topology
 * write pays the build. Item 1694 measured `handCsrPlusBuild` at **0.83x — a LOSS** on the first
 * query, against 6.00x warm. So a warm-only A/B would be answering a different question than the
 * one a user has.
 *
 * So this file reports BOTH: the warm median (reps 3+) and the COLD first rep, for each arm, at
 * whatever `N` it is given. PRE kills `hopValuesCsr` in the BUILT dist, POST is shipped, both arms
 * asserted by marker.
 *
 *     N=200000 FANOUT=5 bun hop-csr-ab-1889.mjs
 *     N=20000 FANOUT=5 bun hop-csr-ab-1889.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1889-dist.mjs`;

const REPS = process.env.REPS ?? '30';
const SHAPES = ['hop', 'hop2', 'optional'];

const KILLS = [['hopValuesCsr(effective, graph)', '(void 0 /* KILL_1889 */)']];

const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const measure = (shape) => {
  const r = spawnSync('timeout', ['600', 'bun', 'optional-hop-floor-1884.mjs'], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    env: { ...process.env, SHAPE: shape, REPS, SERIES: '1' },
  });

  if (r.status !== 0) {
    throw new Error(`${shape} failed: ${String(r.stderr).slice(-600)}`);
  }

  const m = /([\d.]+) ms/.exec(r.stdout);

  if (m === null) {
    throw new Error(`${shape}: no reading in ${r.stdout}`);
  }

  // The floor probe prints its dropped COLD reps under `SERIES=1`; rep 1 is where the CSR build is.
  const cold = /COLD reps[^:]*: ([\d.]+)/.exec(r.stdout);

  return { warm: Number(m[1]), cold: cold === null ? Number.NaN : Number(cold[1]) };
};

copyFileSync(DIST, PRISTINE);

const rows = [];

try {
  const pristine = readFileSync(PRISTINE, 'utf8');

  for (const [from] of KILLS) {
    if (pristine.split(from).length - 1 !== 1) {
      throw new Error(`kill anchor not found exactly once in the dist: ${from}`);
    }
  }

  const arm = (which) => {
    writeFileSync(
      DIST,
      which === 'PRE'
        ? KILLS.reduce((acc, [from, to]) => acc.replace(from, to), pristine)
        : pristine,
    );

    const killed = readFileSync(DIST, 'utf8').includes('KILL_1889');

    if (killed !== (which === 'PRE')) {
      throw new Error(`ARM ASSERTION FAILED: ${which} build is not the code it claims`);
    }
  };

  for (let round = 0; round < 3; round += 1) {
    // ALTERNATE THE ORDER each round, so neither arm is always first.
    const order = round % 2 === 0 ? ['PRE', 'POST'] : ['POST', 'PRE'];

    for (const which of order) {
      arm(which);

      for (const shape of SHAPES) {
        rows.push([round, which, shape, measure(shape)]);
      }
    }
  }
} finally {
  copyFileSync(PRISTINE, DIST);
}

console.log(
  `# median of ${REPS} reps less 2 warm-up, one shape per process, 3 order-alternated rounds`,
);
console.log('# `hop2` and `optional` are CONTROLS — neither can reach the one-hop CSR walk\n');
console.log('shape          arm  PRE (ms)             POST (ms)            median / median');
console.log('-----------------------------------------------------------------------------------');

for (const shape of SHAPES) {
  const pre = rows.filter(([, w, s]) => w === 'PRE' && s === shape).map(([, , , r]) => r.warm);
  const post = rows.filter(([, w, s]) => w === 'POST' && s === shape).map(([, , , r]) => r.warm);
  const preCold = rows.filter(([, w, s]) => w === 'PRE' && s === shape).map(([, , , r]) => r.cold);
  const postCold = rows
    .filter(([, w, s]) => w === 'POST' && s === shape)
    .map(([, , , r]) => r.cold);
  // ⚠️ THE HEADLINE IS THE MEDIAN OF ROUNDS, NOT THE MIN. On one run the min made the CONTROL read
  // 0.85x off a single low PRE reading (1.92 against 2.33/2.34) while its medians were 2.33 and
  // 2.29 — flat. CLAUDE.md says this in terms for the TS per-row path; it applies to the
  // round-level summary too.
  const bp = med(pre);
  const bq = med(post);

  console.log(
    `${shape.padEnd(10)} warm ${pre
      .map((x) => x.toFixed(1))
      .join(' ')
      .padEnd(20)} ${post
      .map((x) => x.toFixed(1))
      .join(' ')
      .padEnd(20)} ${(bp / bq).toFixed(2)}x`,
  );
  console.log(
    `${''.padEnd(10)} COLD ${preCold
      .map((x) => x.toFixed(1))
      .join(' ')
      .padEnd(20)} ${postCold
      .map((x) => x.toFixed(1))
      .join(' ')
      .padEnd(20)} ${(med(preCold) / med(postCold)).toFixed(2)}x`,
  );
}
