/**
 * DOES EVERY GQL RUNG STILL BEAT THE GENERAL MATCHER IT REPLACES? (item 1872)
 *
 * The GQL twin of item 1871's Gremlin census, built for item 1870's reason: a rung's A/B verdict
 * DECAYS when the arm it beat gets faster, and nothing notices — the rung keeps answering
 * correctly, every test passes, and the regression is invisible. On the Gremlin side that hid a
 * **678x** loss for ~390 items.
 *
 * THE GQL SIDE IS CHEAPER TO DISABLE AND THAT IS THE ONE ADVANTAGE IT HAS. `compileLinear`
 * returns a `CLinear` whose FIELDS are the routes, and `runLinear` dispatches on them — so nulling
 * every function-valued field disables all ~30 detectors in one edit, where Gremlin needed eight
 * call sites patched individually.
 *
 * THE SHAPE CORPUS IS `routes-fired.test.ts`'s OWN TABLE, not a hand-picked list. That file
 * maintains (name, query, expected routes) for every detector, so it cannot drift from the rungs
 * the way a second list would — and the rows whose expected route list is EMPTY are skipped, since
 * a shape no rung claims has no verdict that could have decayed.
 *
 * IT IS A SCREEN, NOT A MEASUREMENT, FOR THE REASON ITEM 1871 LEARNED BY GETTING IT WRONG.
 * Many shapes share a process, and the cross-row inline-cache pollution is NOT symmetric between
 * arms: in arm A the preceding rows exercise assorted RUNGS, in arm B they all exercise the general
 * matcher, so arm B's shared path is warmer by the time a shape runs. That favours arm B — the arm
 * a flag accuses. Item 1871's single flag (`hop1: id`, 1.54x) was refuted by isolation at 4.89x in
 * the RUNG's favour. So: a flag is a candidate, a ratio near 1.0 means nothing, and the margin is
 * what carries signal.
 *
 *     bun gql-rung-earns-its-place-1872.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '../gql/src/executor/rewrites.ts';
const PRISTINE = '../../crates/lenke-engine/target/pristine-1872-rewrites.ts';
const MARKER = 'LENKE_GQL_NO_RUNGS_1872';

/** The shapes, parsed out of `routes-fired.test.ts` so the two cannot disagree. */
const shapes = () => {
  const src = readFileSync('../gql/src/routes-fired.test.ts', 'utf8');
  const from = src.indexOf('const CASES:');
  const block = src.slice(from, src.indexOf('\n  ];', from));
  const re = /\[\s*'([^']+)',\s*\n?\s*'((?:[^'\\]|\\.)*)',\s*\n?\s*\[([^\]]*)\],?\s*\n?\s*\]/g;
  const out = [];

  for (const m of block.matchAll(re)) {
    const routes = m[3].trim();

    // A shape no rung claims has no verdict to decay.
    if (routes.length > 0) {
      out.push({ name: m[1], query: m[2], routes });
    }
  }

  if (out.length < 30) {
    throw new Error(`parsed only ${String(out.length)} shapes — the table's shape changed`);
  }

  return out;
};

const SHAPES = shapes();

const DRIVER = (json) => `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20000);
const REPS = Number(process.env.REPS ?? 7);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: \`v\${i}\`, labels: ['L'], properties: { k: i % 97, n: i % 13, list: [1, 2, 3] } });
}

for (let i = 0; i < N; i += 1) {
  g.addEdge({
    id: \`e\${i}\`,
    from: g.getVertexById(\`v\${i}\`),
    to: g.getVertexById(\`v\${(i * 7 + 3) % N}\`),
    labels: ['R'],
    properties: { w: i % 11 },
  });
}

const SHAPES = ${json};
const params = { s: 2, n: 5 };
const out = {};

for (const { name, query: text } of SHAPES) {
  const s = [];
  let ok = true;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    try {
      query(g, text, params);
    } catch {
      ok = false;
    }

    const ms = performance.now() - t0;

    if (r >= 2) s.push(ms);
  }

  s.sort((a, b) => a - b);
  out[name] = { ms: s[s.length >> 1], ok };
}

console.log(JSON.stringify(out));
`;

const build = () => execFileSync('npx', ['nx', 'build', '@lenke/gql'], { cwd: '../..' });

const measure = () => {
  const file = `./driver-1872-${String(Date.now())}.mjs`;

  writeFileSync(file, DRIVER(JSON.stringify(SHAPES)));

  const raw = execFileSync('bun', [file], { encoding: 'utf8' });

  execFileSync('rm', ['-f', file]);

  return JSON.parse(raw.trim().split('\n').pop());
};

copyFileSync(SRC, PRISTINE);

try {
  build();
  console.log(`# ${String(SHAPES.length)} rung-claiming shapes, from routes-fired.test.ts`);
  console.log('# arm A: shipped rungs');

  const rung = measure();

  const base = readFileSync(SRC, 'utf8');
  const open = '\n  return {\n    clauses,\n';
  const close = '    writes: clauses.some((clause) => WRITE_CLAUSES.has(clause.kind)),\n  };\n};';

  if (base.split(open).length - 1 !== 1 || base.split(close).length - 1 !== 1) {
    throw new Error('the CLinear literal did not match its expected anchors');
  }

  const patched = base
    .replace(open, `\n  const out: CLinear = {\n    clauses,\n`)
    .replace(
      close,
      `    writes: clauses.some((clause) => WRITE_CLAUSES.has(clause.kind)),\n` +
        `  };\n\n` +
        `  // ${MARKER}\n` +
        `  for (const key of Object.keys(out)) {\n` +
        `    const rec = out as unknown as Record<string, unknown>;\n\n` +
        `    if (typeof rec[key] === 'function') {\n` +
        `      rec[key] = null;\n` +
        `    }\n` +
        `  }\n\n` +
        `  return out;\n};`,
    );

  writeFileSync(SRC, patched);
  build();

  const inDist =
    execFileSync('grep', ['-rl', MARKER, 'dist'], { cwd: '../gql', encoding: 'utf8' }).trim()
      .length > 0;

  if (!inDist) {
    throw new Error('the patched build did not reach the dist — refusing to measure');
  }

  console.log('# arm B: every rung nulled (marker asserted in dist)');

  const general = measure();

  console.log('');
  console.log('shape                                   rung    general   rung/gen  verdict');
  console.log('---------------------------------------------------------------------------');

  const flagged = [];

  for (const { name } of SHAPES) {
    const a = rung[name];
    const b = general[name];
    const ratio = b.ms === 0 ? 0 : a.ms / b.ms;
    const bad = ratio > 1.25;

    if (bad) {
      flagged.push([name, ratio]);
    }

    console.log(
      `${name.slice(0, 37).padEnd(38)} ${a.ms.toFixed(2).padStart(7)} ${b.ms
        .toFixed(2)
        .padStart(10)} ${ratio.toFixed(2).padStart(9)}x  ${bad ? 'GENERAL WINS' : ''}${
        a.ok === b.ok ? '' : '  ARMS DISAGREE ON RAISING'
      }`,
    );
  }

  console.log('');

  if (flagged.length === 0) {
    console.log('# every rung still beats the general matcher (within the 1.25x flag threshold).');
  } else {
    console.log('# CANDIDATES — each needs its own ISOLATED one-shape-per-process A/B:');

    for (const [name, ratio] of flagged) {
      console.log(`#   ${name}  ${ratio.toFixed(2)}x`);
    }
  }
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('# restored and rebuilt');
}
