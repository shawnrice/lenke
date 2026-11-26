/**
 * DOES `splice-chained-patterns.test.ts` HAVE TEETH? (item 1844)
 *
 * The rewrite is ANSWER-EQUIVALENT by construction, so every answer test in that file passes
 * whether or not it fires — which is exactly how its first version shipped doing nothing (it
 * tested `selector === undefined`, but the parser writes `'walk'`). That makes mutation the only
 * honest check here, and it has to include a mutant that simply DISABLES the rewrite: if that one
 * survives, the file is measuring nothing.
 *
 * Result lines: `bun test` writes them to STDERR. Both streams are concatenated before the
 * exit code is read.
 *
 *     bun splice-mutants.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gql/src/executor/rewrites.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1844-rewrites.ts`;

const MUTANTS = {
  'M1 the rewrite never fires (the null-result mutant)': [
    [
      'export const spliceChainedPatterns = (clauses: readonly Clause[]): readonly Clause[] => {',
      'export const spliceChainedPatterns = (clauses: readonly Clause[]): readonly Clause[] => {\n  if (clauses.length >= 0) {\n    return clauses;\n  }\n',
    ],
  ],
  'M2 a QUANTIFIED segment is spliced (trail applied across the merged walk)': [
    ['!quantified(p);', 'true;'],
  ],
  'M3 a non-bare joining node is spliced (its label silently dropped)': [
    [
      'const bareBackReference = (n: NodePattern): boolean =>\n  n.variable !== undefined &&\n  n.label === undefined &&',
      'const bareBackReference = (n: NodePattern): boolean =>\n  n.variable !== undefined &&',
    ],
  ],
  'M4 the join variable is not compared (any two patterns merge)': [
    ['right.start.variable !== joinOn', 'false'],
  ],
  'M5 a path variable is spliced away': [
    [
      'p.pathVar === undefined &&\n  (p.selector === undefined',
      'true &&\n  (p.selector === undefined',
    ],
  ],
};

const restore = () => copyFileSync(PRISTINE, SRC);

const apply = (edits) => {
  let applied = 0;

  for (const [find, replace] of edits) {
    const s = readFileSync(SRC, 'utf8');
    const hits = s.split(find).length - 1;

    if (hits !== 1) {
      console.log(`     anchor matched ${hits} times — NOT applied`);
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

/**
 * BOTH STREAMS, ON BOTH PATHS — and the first version of this function got it wrong in the way
 * CLAUDE.md names explicitly. `execFileSync` returns only STDOUT on success, and `bun test` writes
 * `N pass` / `N fail` to STDERR, so three surviving mutants were reported as `DID-NOT-RUN`: a
 * diagnostic that made a passing run look like an absent one. `spawnSync` hands back both streams
 * whatever the exit code.
 */
const runTests = () => {
  const r = spawnSync('bun', ['test', 'src/splice-chained-patterns.test.ts'], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });

  return { code: r.status ?? -1, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

copyFileSync(SRC, PRISTINE);

console.log('# splice-mutants — M1 is the control: if it SURVIVES, the test file proves nothing\n');

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
