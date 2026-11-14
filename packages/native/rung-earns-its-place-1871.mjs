/**
 * DOES EVERY GREMLIN SHORTCUT STILL BEAT THE PIPELINE IT REPLACES? (item 1871)
 *
 * ⚠️⚠️ THE INSTRUMENT ITEM 1870 PROVED WAS MISSING. `nodeValuesShortcut` was shipped at item 1482
 * on a measured **2.39x**, the pipeline later learned to seed a leading `hasLabel` from the label
 * index, and the rung silently became **up to 678x SLOWER than the route it displaced**. Nothing
 * caught it for ~390 items: the rung kept returning correct answers, and the whole gremlin suite
 * passes either way, so there was no signal at all.
 *
 * **An A/B's verdict decays when the arm it beat gets faster, and no existing instrument asks
 * whether a rung still earns its place.** The route screen says WHICH route answers a shape; the
 * bench says how fast a shape is. Neither compares a rung against its own alternative. This does,
 * for every shortcut at once.
 *
 * ### How
 *
 * One patch wraps all eight shortcut call sites in `run` with a `NO_SHORTCUTS` guard, so arm B is
 * the generic traverser pipeline for every shape. Both arms then run the SAME shapes in the SAME
 * order against the SAME fixture, and the ratio is the question: a shape whose pipeline arm is
 * FASTER has a rung that no longer earns its place.
 *
 * ⚠️ IT IS A MUTATION RUN. A pristine copy goes under `target/`, the patched build is ASSERTED
 * present in the dist before anything is measured (a silently-unpatched arm would report every
 * rung as winning and look like very good news), and the restore is in a `finally` — an interrupted
 * run must not leave a patched engine in the tree.
 *
 * ⚠️⚠️ **THIS IS A SCREEN, NOT A MEASUREMENT, AND THE HEADER USED TO CLAIM OTHERWISE.** It said
 * sharing one process was sound because the cross-row inline-cache pollution is "SYMMETRIC: every
 * shape occupies the same position in both arms". **That is wrong, and the instrument's own first
 * run disproved it.** The arms differ by more than the build: in arm A the rows before a given
 * shape exercise assorted RUNGS, while in arm B they all exercise the PIPELINE — so by the time a
 * shape runs, arm B's pipeline is thoroughly warm and arm A's rung may not be. The pollution
 * favours arm B, which is the arm a flag accuses.
 *
 * It flagged `hop1: id` at 1.54x, and an isolated one-shape-per-process A/B refuted it outright:
 * the rung is **4.89x FASTER** (14.85 ms against the pipeline's 72.58), with its sibling `values`
 * arm flat at 21.71/21.40 as a control. So:
 *
 *   - a FLAG IS A CANDIDATE, never a finding — isolate it before believing it;
 *   - a ratio anywhere near 1.0 means nothing at all;
 *   - what the screen is good for is the LARGE margin. Item 1870's regression was 678x, which no
 *     cache effect can manufacture, and that is the class this exists to catch.
 *
 *     bun rung-earns-its-place-1871.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '../gremlin/src/executor/index.ts';
const PRISTINE = '../../crates/lenke-engine/target/pristine-1871-index.ts';

const CALLS = [
  'countShortcut',
  'groupCountShortcut',
  'scanValuesShortcut',
  'idSeededValuesShortcut',
  'seededNodeValuesShortcut',
  'hopValuesShortcut',
  'hopChainValuesShortcut',
  'fusedProjectedResidual',
];

const MARKER = 'LENKE_NO_SHORTCUTS_1871';

/**
 * The shapes. Only ones a shortcut CLAIMS are worth asking about — a shape already on the pipeline
 * has no rung whose verdict could have decayed. Taken from `gremlin-route-screen.mjs`'s SHORTCUT
 * rows, plus the label forms item 1870 just moved.
 */
const SHAPES = {
  'scan: values': "traversal(V(), values('k'))",
  // ⚠️ THE ITEM 1870 CLASS, kept as this census's own TEETH CHECK. The rung refuses a label now, so
  // both arms run the pipeline and it reads ~1.0x; re-admit the label and the census must flag it.
  // Verified by doing exactly that — see item 1871.
  'scan: hasLabel values': "traversal(V(), hasLabel('S'), values('k'))",
  'scan: count': 'traversal(V(), count())',
  'scan: has count': "traversal(V(), has('k', 3), count())",
  'scan: values dedupe': "traversal(V(), values('k'), dedupe())",
  'hop1: values': "traversal(V(), out('E'), values('k'))",
  'hop1: count': "traversal(V(), out('E'), count())",
  'hop1: id': "traversal(V(), out('E'), id())",
  'hop1: dedupe count': "traversal(V(), out('E'), dedupe(), count())",
  'hop1: has count': "traversal(V(), out('E'), has('k', 3), count())",
  'hop1: order values': "traversal(V(), out('E'), values('k'), order())",
  'hop1: min': "traversal(V(), out('E'), values('k'), min())",
  'hop1: both count': "traversal(V(), both('E'), count())",
  'hop2: values': "traversal(V(), out('E'), out('E'), values('k'))",
  'hop2: count': "traversal(V(), out('E'), out('E'), count())",
  'hop2: dedupe count': "traversal(V(), out('E'), out('E'), dedupe(), count())",
  'hop2: min': "traversal(V(), out('E'), out('E'), values('k'), min())",
  'hop3: count': "traversal(V(), out('E'), out('E'), out('E'), count())",
  'agg: groupCount by': "traversal(V(), groupCount().by('k'))",
  'agg: hop groupCount': "traversal(V(), out('E'), groupCount().by('k'))",
  'seed: V(id) values': "traversal(V('v7'), values('k'))",
  'seed: V(id) hop count': "traversal(V('v7'), out('E'), count())",
  'seed: hasId values': "traversal(V(), hasId('v7'), values('k'))",
  'edge: E count': 'traversal(E(), count())',
  'edge: E values': "traversal(E(), values('w'))",
};

const DRIVER = () => `
import { Graph } from '@lenke/core';
import {
  E, V, both, count, dedupe, groupCount, has, hasId, hasLabel, id, min, order, out, toArray,
  traversal, values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 60000);
const REPS = Number(process.env.REPS ?? 7);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: \`v\${i}\`, labels: i % 3 === 0 ? ['T', 'S'] : ['T'], properties: { k: i % 997 } });
}

for (let i = 0; i + 1 < N; i += 1) {
  g.addEdge({ id: \`e\${i}\`, from: g.getVertexById(\`v\${i}\`), to: g.getVertexById(\`v\${(i * 7 + 3) % N}\`), labels: ['E'], properties: { w: i % 11 } });
}

const SHAPES = {
${Object.entries(SHAPES)
  .map(([k, v]) => `  ${JSON.stringify(k)}: () => ${v},`)
  .join('\n')}
};

const out2 = {};

for (const [name, make] of Object.entries(SHAPES)) {
  const plan = make();
  const s = [];

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    try { toArray(plan, g); } catch { /* a shape may raise; both arms raise alike */ }
    const ms = performance.now() - t0;
    if (r >= 2) s.push(ms);
  }

  s.sort((a, b) => a - b);
  out2[name] = s[s.length >> 1];
}

console.log(JSON.stringify(out2));
`;

const build = () => execFileSync('npx', ['nx', 'build', '@lenke/gremlin'], { cwd: '../..' });

const distHas = (needle) => {
  const out = execFileSync('grep', ['-rl', needle, 'dist'], {
    cwd: '../gremlin',
    encoding: 'utf8',
  }).trim();

  return out.length > 0;
};

const measure = () => {
  const file = `./driver-1871-${String(Date.now())}.mjs`;

  writeFileSync(file, DRIVER());

  const raw = execFileSync('bun', [file], { encoding: 'utf8', env: { ...process.env } });

  execFileSync('rm', ['-f', file]);

  return JSON.parse(raw.trim().split('\n').pop());
};

copyFileSync(SRC, PRISTINE);

try {
  // ARM A: the shipped rungs.
  build();
  console.log('# arm A: shipped rungs');

  const rung = measure();

  // ARM B: every shortcut call site disabled.
  const base = readFileSync(SRC, 'utf8');
  let patched = base;

  for (const call of CALLS) {
    const before = patched;

    patched = patched.replace(
      new RegExp(`(?<!const )\\b${call}\\(`, ''),
      `${MARKER}_OFF ? undefined : ${call}(`,
    );

    if (patched === before) {
      throw new Error(`could not patch the call site for ${call}`);
    }
  }

  patched = `const ${MARKER}_OFF = true; // ${MARKER}\n${patched}`;
  writeFileSync(SRC, patched);
  build();

  if (!distHas(MARKER)) {
    throw new Error('the patched build did not reach the dist — refusing to measure');
  }

  console.log('# arm B: every shortcut disabled (marker asserted in dist)');

  const pipeline = measure();

  console.log('');
  console.log('shape                        rung      pipeline    rung/pipe  verdict');
  console.log('----------------------------------------------------------------------');

  const flagged = [];

  for (const name of Object.keys(SHAPES)) {
    const a = rung[name];
    const b = pipeline[name];
    const ratio = b === 0 ? 0 : a / b;
    const bad = ratio > 1.25;

    if (bad) {
      flagged.push([name, ratio]);
    }

    console.log(
      `${name.padEnd(26)} ${a.toFixed(3).padStart(8)} ${b.toFixed(3).padStart(13)} ${ratio
        .toFixed(2)
        .padStart(11)}x  ${bad ? '⚠️ PIPELINE WINS' : ''}`,
    );
  }

  console.log('');

  if (flagged.length === 0) {
    console.log('# every rung still beats its pipeline (within the 1.25x flag threshold).');
  } else {
    console.log('# ⚠️ RUNGS WHOSE VERDICT MAY HAVE DECAYED — each needs its own isolated A/B:');

    for (const [name, ratio] of flagged) {
      console.log(`#   ${name}  ${ratio.toFixed(2)}x slower than the pipeline`);
    }
  }
} finally {
  copyFileSync(PRISTINE, SRC);
  build();
  console.log('# restored and rebuilt');
}
