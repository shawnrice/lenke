/**
 * DOES THE SKIP-ONLY PAGE RUNG PAIR HAVE TEETH? (item 1885)
 *
 * IT PASSED ON ITS FIRST RUN, AND SO DOES A TEST THAT CHECKS NOTHING. CLAUDE.md's rule:
 * "Mutate it and check the fuzzer catches it. A generative test whose teeth were never verified is
 * worse than no test, because it is believed."
 *
 * EACH MUTANT IS ANCHOR-ASSERTED. Items 1870 and 1873 both recorded a mutant whose anchor
 * matched 0 or 2 times, so the "pass" meant nothing — the patch had never applied. Every entry
 * below declares the occurrence count it expects and the run fails loudly otherwise.
 *
 * AND A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` /
 * `N fail` to **stderr**, so both streams are concatenated and a result line is required before
 * the exit code is read (items 767/772-773 got this wrong in both directions).
 *
 *     bun chain-paged-mutants-1885.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  hop2: `${ROOT}/packages/gql/src/executor/hop2-projection.ts`,
  chain: `${ROOT}/packages/gql/src/executor/chain-projection.ts`,
  clauses: `${ROOT}/packages/gql/src/executor/clauses.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1885`;
// BOTH test files, because the two halves catch different mutants: the answer file catches a
// missing slice, the ROUTE file catches a rung that starts claiming shapes it must leave alone —
// and a route change is answer-equivalent, which is `perf-gate-needs-its-own-test` exactly.
const TESTS = [
  'src/chain-paged-page.test.ts',
  'src/routes-fired.test.ts',
  // THE THIRD FILE EXISTS BECAUSE OF THIS RUNNER. The `clauses` mutant below — replacing the
  // consumer call with `undefined` — SURVIVED the first two (92 passing tests), since dropping a
  // consumer is answer-equivalent and the route file pins only that the DETECTOR fires.
  'src/paged-width-consumer.test.ts',
];

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  ['chain: the slice is dropped', 'chain', 'return pagedRows(rows, skip);', 'return rows;', 1],
  ['hop2: the slice is dropped', 'hop2', 'return pagedRows(rows, skip);', 'return rows;', 1],
  [
    'chain: claims UNWINDOWED shapes too (route change, answer-equivalent)',
    'chain',
    'if (skip === null || skip === 0) {',
    'if (skip === null) {',
    1,
  ],
  [
    'hop2: the window is not stripped before the base rung',
    'hop2',
    `  const rows = detectHop2Projection(
    clauses.map((c, i) => (i === 1 ? withoutSortOrWindow(c) : c)),
    compiled.map((c, i) => (i === 1 ? withoutSortOrWindow(c) : c)),
  );

  return pagedRows(rows, skip);`,
    '  const rows = detectHop2Projection(clauses, compiled);\n\n  return pagedRows(rows, skip);',
    1,
  ],
  [
    'clauses: the helper returns a per-call `null` as the answer',
    'clauses',
    `  if (linear.chainPagedProjection) {
    const rows = linear.chainPagedProjection(graph, params);

    if (rows !== null) {
      return rows;
    }
  }

  if (linear.hop2PagedProjection) {`,
    `  if (linear.chainPagedProjection) {
    return linear.chainPagedProjection(graph, params);
  }

  if (linear.hop2PagedProjection) {`,
    1,
  ],
  /**
   * AN EXPECTED SURVIVOR, WITH ITS REASON — not a hole newly discovered here. Dropping the branch
   * that CONSUMES a rung is answer-equivalent: the query falls to the general matcher and returns
   * the same rows, more slowly. `clauses.ts`'s own note says this of all the rungs ("removing the
   * branch that CONSUMES it is answer-equivalent and the whole suite passes"), and item 1619 checked
   * whether row ORDER could distinguish the two paths and it cannot.
   *
   * AND EXPORTING THE COMPOSITION DID NOT CLOSE IT, which is worth recording because
   * [[rewrite-composition-is-not-free]]'s rule says to try exactly that. `paged-width-consumer.test.ts`
   * pins the HELPER — its precedence, its `null` fall-through, an empty result as a real answer —
   * and the mutant below removes the CALL SITE, which no direct test of the helper can see. Closing
   * it needs an observable difference between the two routes, and there is none by construction;
   * the remaining instrument is `rung-gap-screen.mjs`, which is a timing screen and rightly not a
   * test.
   */
  [
    'EXPECTED SURVIVOR — clauses: the call site is removed',
    'clauses',
    'const paged = pagedWidthProjections(linear, graph, params);',
    'const paged = undefined;',
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry above. */
const EXPECTED_SURVIVORS = new Set(['EXPECTED SURVIVOR — clauses: the call site is removed']);

/**
 * BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
};

const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

// Each of the three sources gets its own pristine copy under `target/` (gitignored, and it survives
// the reboot a runaway mutant may force — CLAUDE.md's rule, learned when `/tmp` was wiped).
for (const [key, path] of Object.entries(SRCS)) {
  copyFileSync(path, `${PRISTINE}-${key}.ts`);
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(SRCS)) {
    copyFileSync(`${PRISTINE}-${key}.ts`, path);
  }
};

const survivors = [];

try {
  // The BASELINE must pass, or every mutant "fails" for the wrong reason.
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop — an interrupted run must
    // not leave a mutant in the tree for `git diff` to be the only thing standing in its way.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    writeFileSync(SRCS[which], pristine.replace(from, to));

    const r = run();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text);

    if (!ran && r.code !== 124) {
      console.log(`  DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
      survivors.push(`${name} (no result line)`);
      continue;
    }

    const caught = r.code === 124 ? 'TIMEOUT (caught)' : r.code !== 0;

    const expected = EXPECTED_SURVIVORS.has(name);

    if (caught === false && !expected) {
      survivors.push(name);
    }

    if (caught !== false && expected) {
      survivors.push(`${name} (was expected to SURVIVE and did not — update the entry)`);
    }

    console.log(
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(30)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
