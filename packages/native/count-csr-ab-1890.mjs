/**
 * DOES THE TWO-HOP COUNT'S CSR DEGREE PRODUCT EARN ITS PLACE — WARM AND COLD? (item 1890)
 *
 * The GQL twin of `hop-csr-ab-1889.mjs`, and it exists for the same reason: the CSR's build is paid
 * by the first query after any topology write, so a warm-only A/B answers a different question than
 * the one a user has. Isolated, this shape went **23.97 ms warm -> 0.20** and **91 ms cold -> 181**
 * before the second-ask policy.
 *
 * PRE disables the arm in the BUILT dist by `&&`-ing its call site to `null`, POST is shipped, both
 * arms asserted by marker. Depth 2 is the target; depths 3 and 4 ride arms this change cannot reach
 * and are the controls.
 *
 *     N=200000 bun count-csr-ab-1890.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gql/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1890-dist.mjs`;

const REPS = process.env.REPS ?? '30';
// The DEPTH is the axis here: depth 2 is the target, depths 3 and 4 are controls on other arms.
const SHAPES = ['2', '3', '4'];

const KILLS = [
  [
    'const viaCsr = twoHopCsrProduct(graph, {',
    'const viaCsr = null /* KILL_1890 */ && twoHopCsrProduct(graph, {',
  ],
];

const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const measure = (shape) => {
  const r = spawnSync('timeout', ['600', 'bun', 'count-depth-floor-1890.mjs'], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    env: { ...process.env, DEPTH: shape, SHAPE: 'count', REPS },
  });

  if (r.status !== 0) {
    throw new Error(`${shape} failed: ${String(r.stderr).slice(-600)}`);
  }

  const m = /([\d.]+) ms/.exec(r.stdout);

  if (m === null) {
    throw new Error(`${shape}: no reading in ${r.stdout}`);
  }

  // The floor probe prints its dropped COLD reps under `SERIES=1`; rep 1 is where the CSR build is.
  const cold = /cold (\d+)/.exec(r.stdout);

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

    const killed = readFileSync(DIST, 'utf8').includes('KILL_1890');

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
console.log(
  '# depth 2 is the TARGET; depths 3 and 4 are CONTROLS on arms this change cannot reach\n',
);
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
    `${`depth ${shape}`.padEnd(10)} warm ${pre
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
