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
const FILES = { hop: 'hop-projection' };
const srcOf = (k) => `${ROOT}/packages/gql/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1850-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'U1 the read test always says UNREAD (a read variable would take the rung)': [
    ['hop', 'rel.variable !== undefined && returnReadsName(ret, rel.variable)', 'false'],
  ],
  'U2 the read test always says READ (null-result control: nothing is admitted)': [
    [
      'hop',
      'rel.variable !== undefined && returnReadsName(ret, rel.variable)',
      'rel.variable !== undefined',
    ],
  ],
  'U3 the sort keys are not searched for the name': [
    ['hop', '    ...(projection.orderBy ?? []).map((o) => o.expr),\n', ''],
  ],
  'U4 the subquery guard is dropped': [
    ['hop', '  if (exprs.some(hasSubquery)) {\n    return true;\n  }\n\n', ''],
  ],
  'U5 only the FIRST projected item is searched': [
    [
      'hop',
      '    ...projection.items.map((it) => it.expr),',
      '    ...projection.items.slice(0, 1).map((it) => it.expr),',
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
    ['test', 'src/optional-unread-edgevar.test.ts', 'src/routes-fired.test.ts'],
    { cwd: `${ROOT}/packages/gql`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

console.log('# unread-edgevar-mutants — U2 is the control\n');

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
