/**
 * WHAT IS THE CHAIN WALK'S EAGER FILL WORTH? (item 1894)
 *
 * A `drain` census over the Gremlin walks found `optional-hop-values.ts` carrying ONE — item 1891's
 * `csrOneHop` — so the chain arm item 1888 built was still spreading a generator, on the largest
 * absolute this surface has at scale (~495 ms for 3,200,000 rows at 200,000 vertices).
 *
 * PRE renames the drain in the BUILT dist, which is exactly the state before this item: `toArray`
 * reads `drain` only when it is a function on the walk. POST is shipped. Both arms asserted.
 *
 *     N=200000 FANOUT=5 bun chain-drain-ab-1894.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const DIST = `${ROOT}/packages/gremlin/dist/esm/index.mjs`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1894-dist.mjs`;

const REPS = process.env.REPS ?? '30';
// `optional` is the TARGET; `hop` and `opt2` ride other arms and are the controls.
// `opt2` is the TARGET (the chain CSR walk's eager fill); the rest cannot reach this drain.
const SHAPES = ['opt2', 'optional', 'hop', 'hop2'];

const KILLS = [
  // ⚠️ RENAMING THE DRAIN IS THE KILL: `toArray` reads `drain` only if it is a FUNCTION on the
  // walk, so a renamed method sends it back to spreading the generator — which is exactly the state
  // before this item. The anchor includes the comment above the method so it is unique in the dist.
  [
    'ORDERED.\n\t*/\n\tdrain() {\n\t\tconst { pick, drops } = spec;\n\t\tconst csrs = sha',
    'ORDERED.\n\t*/\n\tdrain_KILL_1894() {\n\t\tconst { pick, drops } = spec;\n\t\tconst csrs = sha',
  ],
];

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

    const killed = readFileSync(DIST, 'utf8').includes('KILL_1894');

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
  '# `opt2` is the TARGET (the chain CSR walk); `optional`, `hop` and `hop2` cannot reach this drain\n',
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
