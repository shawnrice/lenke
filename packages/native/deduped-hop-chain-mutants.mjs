/**
 * DOES `optional-ordered-answers.test.ts` HAVE TEETH? (item 1849)
 *
 * O5 is the control: it stops the rung being selected. If that SURVIVES, every case is running the
 * general matcher and the file says nothing about the new route.
 *
 * ⚠️ Both streams are read before the exit code — `bun test` reports to STDERR.
 *
 *     bun optional-ordered-mutants.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const FILES = { cs: 'count-shortcut' };
const srcOf = (k) => `${ROOT}/packages/gremlin/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1855-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'D1 the rung is never selected (null-result control)': [
    [
      'cs',
      '  if (mid.length < 3) {\n    return undefined; // two hops plus the `dedupe`',
      '  if (mid.length < 3 || true) {\n    return undefined; // two hops plus the `dedupe`',
    ],
  ],
  'D2 it claims ONE hop too, stealing the cheaper closed form': [
    [
      'cs',
      '  if (mid.length < 3) {\n    return undefined; // two hops plus the `dedupe`',
      '  if (mid.length < 2) {\n    return undefined; // two hops plus the `dedupe`',
    ],
  ],
  'D3 the final frontier is not the one counted (off by a level)': [
    ['cs', '    frontier = next;\n\n    if (next.size === 0) {', '    if (next.size === 0) {'],
  ],
  'D4 a by-modulated dedupe is admitted (it dedupes on something else)': [
    [
      'cs',
      "  if (last.kind !== 'dedupe' || (last.labels?.length ?? 0) > 0 || (last.bys?.length ?? 0) > 0) {",
      "  if (last.kind !== 'dedupe') {",
    ],
  ],
  'D5 the IN direction reads the wrong endpoint': [
    [
      'cs',
      '            next.add(forward ? e.to : e.from);\n          }\n        }\n\n        continue;',
      '            next.add(e.to);\n          }\n        }\n\n        continue;',
    ],
  ],
  'D6 a typed hop reads every bucket instead of its own': [
    [
      'cs',
      '      for (const label of labels) {\n        const set = box.get(label);',
      '      for (const label of [...labels, ...box.keys()]) {\n        const set = box.get(label);',
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
      console.log(`     ⚠️ anchor matched ${hits} times in ${where} — NOT applied`);
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
    [
      'test',
      'src/executor/deduped-hop-chain-count.test.ts',
      'src/executor/trailing-filtered-hop-count.test.ts',
    ],
    { cwd: `${ROOT}/packages/gremlin`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

console.log('# deduped-hop-chain-mutants — D1 is the control\n');

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
      console.log(`${label}\n     ⚠️ DID-NOT-RUN — no result line on either stream\n`);
      continue;
    }

    const fails = /([1-9]\d*) fail/.exec(text);

    console.log(
      `${label}\n     ${code === 0 ? '⚠️ SURVIVED' : `CAUGHT (${fails ? fails[1] : '?'} failing)`}\n`,
    );
  }
} finally {
  restore();
  build();
  console.log('# restored and rebuilt');
}
