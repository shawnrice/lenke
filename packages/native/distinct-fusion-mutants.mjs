/**
 * DOES `distinct-fusion-answers.test.ts` HAVE TEETH? (item 1843)
 *
 * It passed on its first run, and so does a test that checks nothing. CLAUDE.md's rule: mutate the
 * code and confirm the test catches it, or the test is worse than no test because it is believed.
 *
 * ⚠️ A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes its `N pass` /
 * `N fail` line to STDERR, never stdout. Items 767 and 772-773 each got this backwards in one
 * direction or the other. So: concatenate both streams, find a result line there, and only then
 * read the exit code.
 *
 * ⚠️ RESTORE BEFORE EACH MUTANT, never only after the loop — an interrupted loop otherwise leaves
 * the mutant in the tree with `git diff` the only thing between it and a commit.
 *
 * ⚠️ MUTANTS ARE APPLIED TO BOTH RUNGS WHERE THE CODE IS DUPLICATED. `chain-projection` and
 * `hop2-projection` each carry their own copy of the fusion; item 1832 learned that a mutant and a
 * test have to actually MEET.
 *
 *     bun distinct-fusion-mutants.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const NAMES = ['chain-projection', 'hop2-projection'];
const srcOf = (n) => `${ROOT}/packages/gql/src/executor/${n}.ts`;
const pristineOf = (n) => `${ROOT}/crates/lenke-engine/target/pristine-1843-mut-${n}.ts`;
const KEYER = `${ROOT}/packages/gql/src/executor/clauses.ts`;
const KEYER_PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1843-mut-clauses.ts`;

/**
 * Each mutant: a list of [file, find, replace] edits, and how many of them must apply. An edit that
 * does not apply is a BROKEN MUTANT, not a surviving one — it is reported separately, because
 * "applied nothing and the tests passed" reads exactly like "the test has no teeth".
 */
const MUTANTS = {
  'M1 key set hoisted out of the run (shared across executions)': [
    // ⚠️ hop2 ONLY. The chain rung carries the same line TWICE (its walk and its sweep), so a
    // single anchor there matches twice and applies nothing — the first run of this file reported
    // exactly that, as a BROKEN MUTANT rather than a survivor. One unambiguous site is enough to
    // ask the question, and the test covers both rungs.
    [
      'hop2-projection',
      'const keys: OneColumnKeys | undefined = distinct && newOneColumnKeys();',
      'const keys: OneColumnKeys | undefined = hoistedKeys;',
    ],
    [
      'hop2-projection',
      'const [n0, n1, n2] = nodes;',
      'const hoistedKeys = distinct && newOneColumnKeys();\n  const [n0, n1, n2] = nodes;',
    ],
  ],
  'M2 element keys put in the PRIMITIVE space (a string can collide with a vertex)': [
    [
      'clauses',
      'return keys.refs.has(k) ? false : (keys.refs.add(k), true);',
      'return keys.prims.has(k) ? false : (keys.prims.add(k), true);',
    ],
  ],
  'M3 the dedupe test dropped (every row emitted)': [
    [
      'chain-projection',
      'if (addOneColumnKey(dedup.keys, v)) {',
      'if (addOneColumnKey(dedup.keys, v) || true) {',
    ],
    [
      'hop2-projection',
      'if (addOneColumnKey(keys, v)) {',
      'if (addOneColumnKey(keys, v) || true) {',
    ],
  ],
  'M4 the fusion keeps the LAST row per key instead of the first': [
    [
      'chain-projection',
      'if (addOneColumnKey(dedup.keys, v)) {\n    s.out.push({ [dedup.name]: v });\n  }',
      'if (addOneColumnKey(dedup.keys, v)) {\n    s.out.push({ [dedup.name]: v });\n  } else {\n    s.out.push({ [dedup.name]: v });\n    s.out.splice(0, 1);\n  }',
    ],
  ],
};

const pathOf = (name) => (name === 'clauses' ? KEYER : srcOf(name));

const restore = () => {
  for (const n of NAMES) {
    copyFileSync(pristineOf(n), srcOf(n));
  }

  copyFileSync(KEYER_PRISTINE, KEYER);
};

const apply = (edits) => {
  let applied = 0;

  for (const [name, find, replace] of edits) {
    const p = pathOf(name);
    const s = readFileSync(p, 'utf8');
    const hits = s.split(find).length - 1;

    if (hits !== 1) {
      console.log(`     ⚠️ anchor matched ${hits} times in ${name} — edit NOT applied`);
      continue;
    }

    writeFileSync(p, s.replace(find, replace));
    applied += 1;
  }

  return applied;
};

const runTests = () => {
  try {
    const out = execFileSync(
      'bun',
      ['test', 'src/distinct-fusion-answers.test.ts', 'src/chain-distinct-answers.test.ts'],
      { cwd: `${ROOT}/packages/gql`, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    return { code: 0, text: out };
  } catch (e) {
    return { code: e.status ?? -1, text: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const build = () => {
  try {
    execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
};

for (const n of NAMES) {
  copyFileSync(srcOf(n), pristineOf(n));
}

copyFileSync(KEYER, KEYER_PRISTINE);

console.log('# distinct-fusion-mutants — a mutant the tests do not catch is a hole in the tests\n');

try {
  for (const [label, edits] of Object.entries(MUTANTS)) {
    restore();

    const applied = apply(edits);

    if (applied !== edits.length) {
      console.log(`${label}\n     BROKEN MUTANT — ${applied}/${edits.length} edits applied\n`);
      continue;
    }

    if (!build()) {
      console.log(`${label}\n     CAUGHT (did not compile)\n`);
      continue;
    }

    const { code, text } = runTests();
    const ran = /\d+ pass|\d+ fail/.test(text);

    if (!ran) {
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
