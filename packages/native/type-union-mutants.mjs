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
// Three files now (item 1847): the shared helpers plus both rungs.
const FILES = { hop2: 'hop2-projection', chain: 'chain-projection', shared: 'hop-sides' };
const srcOf = (k) => `${ROOT}/packages/gql/src/executor/${FILES[k]}.ts`;
const pristineOf = (k) => `${ROOT}/crates/lenke-engine/target/pristine-1847-mut-${FILES[k]}.ts`;

const MUTANTS = {
  'M1 hop2 de-duplication never runs (a both-labelled edge counts twice)': [
    ['hop2', 'const dedupe = graph.multiTypeEdgeCount > 0;', 'const dedupe = false;'],
  ],
  'M2 hop2 de-duplication ALWAYS runs (answer-equivalent: a PERF choice only)': [
    ['hop2', 'const dedupe = graph.multiTypeEdgeCount > 0;', 'const dedupe = true;'],
  ],
  'M3 the shared claim test treats every edge as claimed (rows dropped)': [
    ['shared', '  for (let i = 0; i < at; i += 1) {', '  for (let i = 0; i <= at; i += 1) {'],
  ],
  'M4 the alternation is not de-duplicated in the SPELLING ([:E|E])': [
    ['shared', 'return { types: [...new Set(types)]', 'return { types: [...types]'],
  ],
  'M5 hop2 walkUnion is never selected (null-result control)': [
    [
      'hop2',
      '    u0 !== null && u1 !== null\n      ? walkUnion(nodes, [u0, u1], projection, gate, distinct)',
      '    false && u0 !== null && u1 !== null\n      ? walkUnion(nodes, [u0, u1], projection, gate, distinct)',
    ],
  ],
  'C1 chain descent de-duplication never runs': [
    [
      'chain',
      'multiLabel: graph.multiTypeEdgeCount > 0,\n    };\n    const [startLabel] = labels;\n\n    for (const a of graph.vertices) {\n      if (!matchesLabel(a, startLabel)) {\n        continue;\n      }\n\n      if (startVar !== undefined) {',
      'multiLabel: false,\n    };\n    const [startLabel] = labels;\n\n    for (const a of graph.vertices) {\n      if (!matchesLabel(a, startLabel)) {\n        continue;\n      }\n\n      if (startVar !== undefined) {',
    ],
  ],
  'C2 chain SWEEP de-duplication never runs': [
    [
      'chain',
      '      multiLabel: graph.multiTypeEdgeCount > 0,\n      nxtLen: 0,',
      '      multiLabel: false,\n      nxtLen: 0,',
    ],
  ],
  'C3 the sweep frontier counter never advances': [
    ['chain', '      s.nxtLen += 1;', '      s.nxtLen += 0;'],
  ],
  'C4 the chain union walks are never selected (null-result control)': [
    [
      'chain',
      '    unionHops.length > 0\n      ? (farOnly ? sweepUnion : walkUnion)',
      '    false && unionHops.length > 0\n      ? (farOnly ? sweepUnion : walkUnion)',
    ],
  ],
  'C5 the chain always takes the DESCENT, never the sweep (answer-equivalent route choice)': [
    ['chain', '(farOnly ? sweepUnion : walkUnion)', '(false ? sweepUnion : walkUnion)'],
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

    if (s.split(find).length - 1 !== 1) {
      console.log(
        `     ⚠️ anchor matched ${s.split(find).length - 1} times in ${where} — NOT applied`,
      );
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
    ['test', 'src/type-union-hop-answers.test.ts', 'src/hop2-projection.test.ts'],
    { cwd: `${ROOT}/packages/gql`, encoding: 'utf8' },
  );

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

for (const k of Object.keys(FILES)) {
  copyFileSync(srcOf(k), pristineOf(k));
}

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
