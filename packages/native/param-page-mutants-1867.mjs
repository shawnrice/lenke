/**
 * MUTATION RUN for item 1867's parameterized-page admission.
 *
 * THIS CHANGE IS NOT ANSWER-EQUIVALENT, UNLIKE MOST ROUTE WORK HERE — a rung that takes a window
 * and applies it wrongly returns the WRONG ROWS, which is why the first cut returned 600 rows where
 * 5 were expected and a zero bound CRASHED. So the answer tests have teeth. What they cannot catch
 * is the admission being REVERTED, which is answer-equivalent; the route assertions in
 * `param-page-rung.test.ts` cover that, and the null control below is the mutant that proves it.
 *
 * EVIDENCE OF EXECUTION FROM BOTH STREAMS — `bun test` reports to STDERR.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '../gql/src/executor/ordered-rows.ts';
const PRISTINE = '../../crates/lenke-engine/target/pristine-1867-mutants.ts';

copyFileSync(SRC, PRISTINE);

const base = readFileSync(SRC, 'utf8');

const MUTANTS = [
  {
    name: 'skip and limit swapped on resolution',
    from: '        skip: resolveCount(plan.page.skip, params) ?? 0,\n        limit: resolveCount(plan.page.limit, params),',
    to: '        skip: resolveCount(plan.page.limit, params) ?? 0,\n        limit: resolveCount(plan.page.skip, params),',
  },
  {
    name: 'an absent skip resolves to 1 instead of 0',
    from: 'skip: resolveCount(plan.page.skip, params) ?? 0,',
    to: 'skip: resolveCount(plan.page.skip, params) ?? 1,',
  },
  {
    name: 'the zero-window guard removed (the crash)',
    from: '  if (limit === 0) {\n    return [];\n  }',
    to: '  if (limit === 0 && false) {\n    return [];\n  }',
  },
  {
    name: 'the page is built from skip only, limit dropped',
    from: '...(paramWindow ? { page: { skip: skip ?? 0, limit } } : {}),',
    to: '...(paramWindow ? { page: { skip: skip ?? 0, limit: undefined } } : {}),',
  },
  {
    name: 'a LITERAL window also routed through page',
    from: '...(paramWindow ? { page: { skip: skip ?? 0, limit } } : {}),',
    to: '...{ page: { skip: skip ?? 0, limit } },',
  },
  {
    // THE NULL CONTROL: the admission reverted. It must SURVIVE every answer test (the general
    // matcher answers the same rows) and DIE on the route assertions.
    name: 'CONTROL — the parameterized window declines again',
    from: "  const paramWindow =\n    (skip !== undefined && typeof skip !== 'number') ||\n    (limit !== undefined && typeof limit !== 'number');",
    to: "  const paramWindow =\n    (skip !== undefined && typeof skip !== 'number') ||\n    (limit !== undefined && typeof limit !== 'number');\n\n  if (paramWindow) {\n    return null;\n  }",
  },
];

const TESTS = [
  'src/param-page-rung.test.ts',
  'src/ordered-node-projection.test.ts',
  'src/windowed-sort-answers.test.ts',
  'src/optional-ordered-answers.test.ts',
  'src/skip-only-page.test.ts',
];

const verdictOf = (r) => {
  if (!r.ran) {
    return 'DID-NOT-RUN';
  }

  if (r.status === 124 || r.status === 137) {
    return `CAUGHT (exit ${String(r.status)})`;
  }

  return r.failed ? 'CAUGHT' : 'SURVIVED';
};

const runTests = () => {
  const r = spawnSync('bun', ['test', ...TESTS], {
    cwd: '../gql',
    encoding: 'utf8',
    timeout: 300_000,
  });
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const fails = /(\d+) fail/.exec(both);

  return {
    ran: /\d+ (pass|fail)/.test(both),
    failed: fails !== null && fails[1] !== '0',
    status: r.status,
  };
};

const baseline = runTests();

console.log(`baseline: ran=${baseline.ran} failed=${baseline.failed} exit=${baseline.status}\n`);

if (!baseline.ran || baseline.failed) {
  copyFileSync(PRISTINE, SRC);

  throw new Error('baseline is not green; refusing to run mutants');
}

for (const m of MUTANTS) {
  copyFileSync(PRISTINE, SRC); // restore BEFORE each, never only after the loop

  const occurrences = base.split(m.from).length - 1;

  if (occurrences !== 1) {
    console.log(`${m.name.padEnd(44)} ANCHOR MATCHED ${occurrences} TIMES — not applied`);
    continue;
  }

  writeFileSync(SRC, base.replace(m.from, m.to));
  console.log(`${m.name.padEnd(44)} ${verdictOf(runTests())}`);
}

copyFileSync(PRISTINE, SRC);
console.log('\nrestored.');
