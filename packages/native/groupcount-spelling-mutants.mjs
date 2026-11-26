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
const FILES = { idx: 'index' };
const srcOf = (k) => `${ROOT}/packages/gremlin/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1856-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'G1 the modulator spelling is rejected again (the original defect)': [
    [
      'idx',
      '  const by = bys[0] ?? keyToBy(last.by);',
      "  const by = typeof bys[0] === 'string' ? keyToBy(bys[0]) : keyToBy(last.by);",
    ],
  ],
  'G2 a non-key by kind is admitted': [
    [
      'idx',
      "  const key = by.kind === 'key' ? by.key : undefined;",
      "  const key = (by as { key?: string }).key ?? 'k';",
    ],
  ],
  'G3 an ambiguous plan carrying BOTH spellings is admitted': [
    [
      'idx',
      '  if ((last.by !== undefined && bys.length > 0) || bys.length > 1) {',
      '  if (false) {',
    ],
  ],
  'G4 a MULTI-by modulation is admitted': [['idx', '|| bys.length > 1) {', '|| false) {']],
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
    ['test', 'src/executor/group-count-by-spelling.test.ts'],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

console.log('# groupcount-spelling-mutants — G1 is the control\n');

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
