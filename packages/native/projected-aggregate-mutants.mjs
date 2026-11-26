/**
 * DOES `optional-ordered-answers.test.ts` HAVE TEETH? (item 1849)
 *
 * O5 is the control: it stops the rung being selected. If that SURVIVES, every case is running the
 * general matcher and the file says nothing about the new route.
 *
 * Both streams are read before the exit code — `bun test` reports to STDERR.
 *
 *     bun optional-ordered-mutants.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const FILES = { idx: 'index', agg: 'aggregation' };
const srcOf = (k) => `${ROOT}/packages/gremlin/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1857-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'P1 the residual fold is never selected (null-result control)': [
    [
      'idx',
      '    const folded = fusableProjectedAggregate(projected.rest);',
      '    const folded = undefined;',
    ],
  ],
  'P2 sum and mean are admitted (order-sensitive, byte-identity)': [
    [
      'agg',
      "  if (kind !== 'min' && kind !== 'max') {",
      "  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {",
    ],
  ],
  'P3 min and max are swapped': [
    [
      'agg',
      "    if (kind === 'min' ? c < 0 : c > 0) {\n      best = v;\n    }\n  }\n\n  return [seen ? best : null];",
      "    if (kind === 'min' ? c > 0 : c < 0) {\n      best = v;\n    }\n  }\n\n  return [seen ? best : null];",
    ],
  ],
  'P4 a null is folded instead of skipped': [
    [
      'agg',
      '  for (const v of values) {\n    if (v == null) {\n      continue;\n    }\n\n    if (!seen) {',
      '  for (const v of values) {\n    if (false) {\n      continue;\n    }\n\n    if (!seen) {',
    ],
  ],
  'P5 an all-null input answers nothing instead of null': [
    ['agg', '  return [seen ? best : null];', '  return seen ? [best] : [];'],
  ],
  'P6 a longer residual is admitted': [
    [
      'agg',
      "): 'min' | 'max' | undefined => {\n  if (rest.length !== 1) {",
      "): 'min' | 'max' | undefined => {\n  if (rest.length < 1) {",
    ],
  ],
};

const restore = () => {
  for (const k of Object.keys(FILES)) {
    copyFileSync(pristineOf(k), srcOf(k));
  }
};

const apply = (edits) => {
  let applied = 0;

  for (const [where, find, replace] of edits) {
    const path = srcOf(where);
    const s = readFileSync(path, 'utf8');
    const hits = s.split(find).length - 1;

    if (hits !== 1) {
      console.log(`     anchor matched ${hits} times in ${where} — NOT applied`);
      continue;
    }

    writeFileSync(path, s.replace(find, replace));
    applied += 1;
  }

  return applied;
};

const build = () => {
  try {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};

const runTests = () => {
  const r = spawnSync(
    'bun',
    // THE RIGHT TEST FILE, and the first version of this runner had the WRONG one: a
    // single-line string replacement missed this array because `fmt` had split it across lines, so
    // four mutants were reported as SURVIVED while the runner executed the previous item's tests.
    // A runner that tests the wrong thing says "survived" in exactly the same words as one that
    // tests the right thing and finds a hole.
    ['test', 'src/executor/projected-aggregate.test.ts'],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

console.log('# projected-aggregate-mutants — P1 is the control\n');

try {
  for (const [label, edits] of Object.entries(MUTANTS)) {
    restore();

    const applied = apply(edits);

    if (applied !== edits.length) {
      console.log(`${label}\n     BROKEN MUTANT — ${applied}/${edits.length} applied\n`);
      continue;
    }

    if (!build()) {
      console.log(`${label}\n     CAUGHT (did not compile)\n`);
      continue;
    }

    const { code, text } = runTests();

    if (!/\d+ pass|\d+ fail/.test(text)) {
      console.log(`${label}\n     DID-NOT-RUN — no result line on either stream\n`);
      continue;
    }

    const fails = /([1-9]\d*) fail/.exec(text);

    console.log(
      `${label}\n     ${code === 0 ? 'SURVIVED' : `CAUGHT (${fails ? fails[1] : '?'} failing)`}\n`,
    );
  }
} finally {
  restore();
  build();
  console.log('# restored and rebuilt');
}
