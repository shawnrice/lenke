/**
 * DOES THE OPTIONAL VALUES RUNG EARN ITS PLACE? (item 1884)
 *
 * ⚠️ IT NEEDS A REAL A/B BECAUSE THE FIRST READING SAID NO. At 9 reps the `optional` arm measured
 * 10.24/8.99 ms before the rung and 9.30 after — a null — while `optional(out(E)).id()` went
 * 7.2 → 4.70. Then a 150-rep profile of the SAME shape read **70.3 ns a row** where the 9-rep floor
 * read **116**, and a printed series explained both: this arm does not plateau for ~12 reps
 * (`9.4 8.5 8.5 7.8 9.7 7.3 7.2 7.1 7.3 8.2 13.2 10.1 6.9 6.3 6.2 6.0 5.8 5.7 …`) where its fused
 * twin is flat from rep 4. A 9-rep window was measuring warm-up as the steady state, in BOTH arms,
 * which is exactly CLAUDE.md's "min-of-N is the wrong estimator … print the per-rep series before
 * trusting any summary of it", and the recipe it gives: more reps, drop the warm-up, take the
 * MEDIAN, and the min of that across order-alternated rounds.
 *
 * ⚠️ TWO BUILDS, ONE SHAPE PER PROCESS. PRE replaces the rung's call site in the BUILT dist with
 * `void 0` — a kill switch, so the shape runs the pipeline it ran before this item — and POST is
 * the shipped build. Both arms are ASSERTED by a marker before any measurement
 * (`edge-filtered-oracle-1883.mjs` caught a `??`-through-`void 0` bug with exactly this assertion).
 *
 * ⚠️ AND THE CONTROL IS A SHAPE THE RUNG CANNOT REACH (`V().out(E).values(n)`), measured in the same
 * rounds. Item 762's lesson: a control moving MORE than the target means the instrument is
 * measuring the build, not the change.
 *
 *     bun optional-ab-1884.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1884-dist.mjs`;
const CALL = 'optionalHopValues(effective, graph)';
const KILLED = '(void 0 /* KILL_1884 */)';
const REPS = process.env.REPS ?? '30';
const SHAPES = ['optional', 'optional_id', 'hop'];

const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const measure = (shape) => {
  const r = spawnSync('timeout', ['600', 'bun', 'optional-hop-floor-1884.mjs'], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    env: { ...process.env, SHAPE: shape, REPS },
  });

  if (r.status !== 0) {
    throw new Error(`${shape} failed: ${String(r.stderr).slice(-600)}`);
  }

  const m = /([\d.]+) ms/.exec(r.stdout);

  if (m === null) {
    throw new Error(`${shape}: no reading in ${r.stdout}`);
  }

  return Number(m[1]);
};

copyFileSync(DIST, PRISTINE);

const rows = [];

try {
  const pristine = readFileSync(PRISTINE, 'utf8');

  if (pristine.split(CALL).length - 1 !== 1) {
    throw new Error('the rung call site is not in the dist exactly once — rebuild, then re-run');
  }

  const arm = (which) => {
    writeFileSync(DIST, which === 'PRE' ? pristine.replace(CALL, KILLED) : pristine);

    const killed = readFileSync(DIST, 'utf8').includes('KILL_1884');

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
console.log('# `hop` is the CONTROL — a shape the rung cannot reach\n');
console.log('shape           PRE (ms)                POST (ms)               median / median');
console.log('-----------------------------------------------------------------------------------');

for (const shape of SHAPES) {
  const pre = rows.filter(([, w, s]) => w === 'PRE' && s === shape).map(([, , , ms]) => ms);
  const post = rows.filter(([, w, s]) => w === 'POST' && s === shape).map(([, , , ms]) => ms);
  // ⚠️ THE HEADLINE IS THE MEDIAN OF ROUNDS, NOT THE MIN. On one run the min made the CONTROL read
  // 0.85x off a single low PRE reading (1.92 against 2.33/2.34) while its medians were 2.33 and
  // 2.29 — flat. CLAUDE.md says this in terms for the TS per-row path; it applies to the
  // round-level summary too.
  const bp = med(pre);
  const bq = med(post);

  console.log(
    `${shape.padEnd(14)} ${pre
      .map((x) => x.toFixed(2))
      .join(' ')
      .padEnd(23)} ` +
      `${post
        .map((x) => x.toFixed(2))
        .join(' ')
        .padEnd(23)} ${(bp / bq).toFixed(2)}x`,
  );
}
