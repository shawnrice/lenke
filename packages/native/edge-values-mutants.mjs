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
const FILES = { idx: 'index', nv: 'node-values' };
const srcOf = (k) => `${ROOT}/packages/gremlin/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1858-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'V1 the edge shortcut is never selected (null-result control)': [
    [
      'idx',
      '    : (nodeValuesShortcut(effective, graph) ?? edgeValuesShortcut(effective, graph));',
      '    : nodeValuesShortcut(effective, graph);',
    ],
  ],
  'V2 the label filter is ignored': [
    [
      'nv',
      '    if (labels !== undefined && !labels.some((l) => e.labels.has(l))) {\n      continue;\n    }',
      '    if (false) {\n      continue;\n    }',
    ],
  ],
  'V3 an ABSENT key is emitted as undefined': [
    [
      'nv',
      '    const props = e.properties;\n\n    if (key in props) {\n      yield props[key];\n    }',
      '    const props = e.properties;\n\n    yield props[key];',
    ],
  ],
  'V4 a SEEDED E(id) source is admitted': [
    [
      'nv',
      "  if (source?.kind !== 'E' || (source.ids?.length ?? 0) > 0) {",
      "  if (source?.kind !== 'E') {",
    ],
  ],
  'V5 a multi-key values is admitted (only the first key emitted)': [
    [
      'nv',
      "  if (source?.kind !== 'E' || (source.ids?.length ?? 0) > 0) {\n    return undefined;\n  }\n\n  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {",
      "  if (source?.kind !== 'E' || (source.ids?.length ?? 0) > 0) {\n    return undefined;\n  }\n\n  if (steps.length === 2 && second?.kind === 'values') {",
    ],
  ],
  'V6 hasLabel requires ALL labels instead of ANY': [
    ['nv', '!labels.some((l) => e.labels.has(l))', '!labels.every((l) => e.labels.has(l))'],
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
    ['test', 'src/executor/edge-values.test.ts'],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

console.log('# edge-values-mutants — V1 is the control\n');

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
