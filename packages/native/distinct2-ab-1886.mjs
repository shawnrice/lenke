/**
 * DOES THE TWO-COLUMN KEY EARN ITS PLACE, AT EVERY CARDINALITY? (item 1886)
 *
 * ⚠️ THE CARDINALITY SWEEP IS THE POINT, not a refinement. The nested-map key allocates one
 * second-column key-pair per DISTINCT FIRST-COLUMN VALUE, where `rowKeyOf` allocates a string per
 * ROW. So the two trade places as the first column's cardinality rises, and a single fixture cannot
 * see that — CLAUDE.md's "match the fixture to the claim" one axis over. At `CARD=20000` every row
 * is distinct and the nested map is at its worst.
 *
 * PRE kills the two-column arm in the BUILT dist (so `distinctRows` falls to `rowKeyOf` exactly as
 * before item 1886), POST is shipped, both arms asserted by marker before any measurement. One
 * shape per process, median of rounds — item 1884's lesson, where min-of-rounds invented 0.85x of
 * control movement.
 *
 *     CARD=97 bun distinct2-ab-1886.mjs
 *     CARD=20000 bun distinct2-ab-1886.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gql/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1886-dist.mjs`;
/**
 * ⚠️ THREE KILL SWITCHES, NOT ONE, AND THE FIRST VERSION OF THIS FILE HAD ONE. Item 1886 gave the
 * two-column key space to THREE callers — `distinctRows`, `distinctUnion` and `twoColumnSetOp` — and
 * killing only the first measured the union and set-op arms POST against POST: three rows read
 * 1.00x / 0.96x / 0.84x, which looks like "no gain, maybe a regression" and is actually "the arm was
 * never disabled". A kill switch that does not cover the change is the `assert each A/B arm IS the
 * code it claims` failure, and the control-shaped result is exactly how it hides.
 */
const KILLS = [
  ['if (isWidth(rows, 2)) {', 'if (false /* KILL_1886 */) {'],
  ['if (isWidth(left, 2) && isWidth(right, 2)) {', 'if (false /* KILL_1886b */) {'],
  [
    'if (!isWidth(left, 2) || right.length > 0 && !isWidth(right, 2)) return;',
    'if (true /* KILL_1886c */) return;',
  ],
];

const REPS = process.env.REPS ?? '30';
const SHAPES = ['distinct2', 'union2', 'except2', 'intersect2', 'twocol', 'distinct1'];

const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const measure = (shape) => {
  const r = spawnSync('timeout', ['600', 'bun', 'distinct2-key-1886.mjs'], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
    env: { ...process.env, SHAPE: shape, REPS, CARD: process.env.CARD ?? '97' },
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

    const killed = readFileSync(DIST, 'utf8').includes('KILL_1886');

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
console.log('# `distinct1` is the CONTROL — the one-column arm the change cannot reach\n');
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
