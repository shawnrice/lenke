/**
 * DOES `type-union-hop-answers.test.ts` HAVE TEETH? (item 1846)
 *
 * M4 is the control: it stops `walkUnion` being selected at all. If that SURVIVES, the file is
 * testing the general matcher and proves nothing about the new walk.
 *
 * ⚠️ Result lines go to STDERR for `bun test`, so both streams are read before the exit code —
 * item 1844's runner reported three survivors as `DID-NOT-RUN` by reading stdout alone.
 *
 *     bun type-union-mutants.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/hop2-projection.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1846-mut.ts`;

const MUTANTS = {
  'M1 de-duplication never runs (a both-labelled edge counts twice)': [
    ['const dedupe = graph.multiTypeEdgeCount > 0;', 'const dedupe = false;'],
  ],
  'M2 de-duplication ALWAYS runs (correct, but the fast arm is never taken)': [
    ['const dedupe = graph.multiTypeEdgeCount > 0;', 'const dedupe = true;'],
  ],
  'M3 every edge is treated as claimed (rows dropped)': [
    ['  for (let i = 0; i < at; i += 1) {', '  for (let i = 0; i <= at; i += 1) {'],
  ],
  'M4 the alternation is not de-duplicated in the SPELLING ([:E|E])': [
    [
      'const seen = new Set(types);\n\n  return { types: [...seen]',
      'const seen = types;\n\n  return { types: [...seen]',
    ],
  ],
  'M5 walkUnion is never selected (the null-result control)': [
    [
      '    u0 !== null && u1 !== null\n      ? walkUnion(nodes, [u0, u1], projection, gate, distinct)',
      '    false && u0 !== null && u1 !== null\n      ? walkUnion(nodes, [u0, u1], projection, gate, distinct)',
    ],
  ],
};

const restore = () => copyFileSync(PRISTINE, SRC);

const apply = (edits) => {
  let applied = 0;

  for (const [find, replace] of edits) {
    const s = readFileSync(SRC, 'utf8');

    if (s.split(find).length - 1 !== 1) {
      console.log(`     ⚠️ anchor matched ${s.split(find).length - 1} times — NOT applied`);
      continue;
    }

    writeFileSync(SRC, s.replace(find, replace));
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
    ['test', 'src/type-union-hop-answers.test.ts', 'src/hop2-projection.test.ts'],
    { cwd: `${ROOT}/packages/gql`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

copyFileSync(SRC, PRISTINE);

console.log('# type-union-mutants — M5 is the control: if it SURVIVES the tests prove nothing\n');

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
