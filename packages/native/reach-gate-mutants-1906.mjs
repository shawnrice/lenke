/**
 * DOES THE CARRIED-START-WHERE GATE HAVE TEETH? (item 1906)
 *
 * THE GATE DECIDES WHICH VERTICES THE WALK SEEDS FROM, so its mistakes are WRONG ANSWERS rather
 * than slow ones — a predicate on the far end admitted as a seed test would narrow the wrong set.
 * That is why `carriedStartGate` is a pure exported function with unit tests, and why those tests
 * are the subject here rather than the detector.
 *
 * `reachability.test.ts` IS IN THE TEST SET BESIDE THE NEW FILE: it is where the rung's existing
 * answers live, so a mutant that breaks the walk rather than the gate still has somewhere to fail.
 *
 *     bun sort-gate-mutants-1902.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { rch: `${ROOT}/packages/gql/src/executor/reachability.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1906`;
const TESTS = ['src/carried-start-gate.test.ts', 'src/reachability.test.ts'];

/** `[name, which, from, to, expectedOccurrences, occurrence?]` */
const MUTANTS = [
  [
    'a FAR-reading predicate is carried as a seed test',
    'rch',
    'if (startVar === undefined || vars.size !== 1 || !vars.has(startVar)) {',
    'if (startVar === undefined) {',
    1,
  ],
  [
    'a predicate reading BOTH ends is carried',
    'rch',
    'vars.size !== 1 || !vars.has(startVar)',
    '!vars.has(startVar)',
    1,
  ],
  [
    'a loop-invariant predicate is carried',
    'rch',
    'vars.size !== 1 || !vars.has(startVar)',
    'vars.size > 1',
    1,
  ],
  [
    'a SUBQUERY predicate is carried',
    'rch',
    'if (hasSubquery(where)) {\n    return null;\n  }',
    '',
    1,
  ],
  [
    'an absent compiled expression is carried anyway',
    'rch',
    'return compiled === undefined ? null : { fn: compiled, variable: startVar };',
    'return { fn: compiled, variable: startVar };',
    1,
  ],
  [
    'no clause WHERE is reported as a DECLINE rather than as absent',
    'rch',
    'if (where === undefined) {\n    return undefined;\n  }',
    'if (where === undefined) {\n    return null;\n  }',
    1,
  ],
  [
    'the gate names the FAR variable instead of the start',
    'rch',
    '{ fn: compiled, variable: startVar }',
    "{ fn: compiled, variable: 'zz_nosuch' }",
    1,
  ],
  ['the seed gate admits every vertex', 'rch', 'return g.fn(env) === true;', 'return true;', 1],
  [
    'the seed gate admits a non-boolean (UNKNOWN) result',
    'rch',
    'return g.fn(env) === true;',
    'return g.fn(env) !== false;',
    1,
  ],
  [
    'the seed gate is never consulted',
    'rch',
    'matchNode(new Map(), cstart, v, params, graph) !== null && seedGate(v),',
    'matchNode(new Map(), cstart, v, params, graph) !== null,',
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry. */
const EXPECTED_SURVIVORS = new Set();

/*
 * AND ONE ENTRY WAS REMOVED FROM THIS SET BECAUSE THE HARNESS CONTRADICTED IT. Reverting the
 * change is ANSWER-EQUIVALENT — the old route returns the same rows, slower — so it was declared an
 * expected survivor on [[perf-gate-needs-its-own-test]] grounds. It is CAUGHT, by the ROUTE
 * assertions in `unwindowed-expr-sort.test.ts`, and the harness said so ("was expected to SURVIVE
 * and did not — update the entry"). That is the rule working in the direction nobody checks.
 */

/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
};

/**
 * BOTH STREAMS, ALWAYS: `bun test` writes `N pass` to **stderr**, and item 767 read an empty
 * stdout and concluded the runner never ran a test.
 */
/**
 * **BOTH PACKAGES, AND THE MUTATION RUN IS WHY.** The gql-side tests cover the pure gate
 * function; three mutants of the RUN-TIME seed gate — admitting every vertex, admitting an UNKNOWN
 * result, never consulting it — all SURVIVED a gql-only run, because the answers that can see them
 * are the cross-engine ones in `packages/native`. A battery whose test set cannot reach the code it
 * mutates reports teeth it does not have.
 */
const NATIVE_TESTS = ['src/reach-carried-where-parity.test.ts'];

/**
 * **THE DIST MUST BE REBUILT PER MUTANT, and the mutation run is what exposed that too.**
 * `@lenke/gql` resolves to `dist` inside `packages/native` ([[fuzzers-read-built-dists]]), so the
 * cross-engine tests ran against an UNMUTATED build and all three run-time seed-gate mutants
 * survived with the native suite nominally in the test set. A battery that mutates source and
 * asserts against a stale artifact is comparing the code to an old copy of itself.
 */
const rebuild = () => {
  spawnSync('bunx', ['nx', 'build', '@lenke/gql', '--skip-nx-cache'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
};

const run = () => {
  rebuild();

  const a = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });
  const b = spawnSync('timeout', ['300', 'bun', 'test', ...NATIVE_TESTS], {
    cwd: `${ROOT}/packages/native`,
    encoding: 'utf8',
  });
  const text = [a.stdout, a.stderr, b.stdout, b.stderr].map((x) => String(x ?? '')).join('');
  // EITHER failing is a catch, so the codes are combined rather than one being read.
  const code = (a.status ?? -1) !== 0 ? (a.status ?? -1) : (b.status ?? -1);

  return { text, code };
};

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
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want, occurrence = 0] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    const parts = pristine.split(from);

    writeFileSync(
      SRCS[which],
      `${parts.slice(0, occurrence + 1).join(from)}${to}${parts.slice(occurrence + 1).join(from)}`,
    );

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

    // THE `N failing` COUNT IS THE GQL RUN'S, because the regex takes the first result line in
    // the concatenated output. A mutant caught only by the NATIVE suite therefore prints
    // `0 failing` beside a — the verdict comes from the exit code, which is the contract
    // (CLAUDE.md: concatenate both streams, find a result line, THEN read the code).
    console.log(
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  // AND REBUILD, or the finally leaves the LAST MUTANT in the dist that every TS harness reads.
  // Restoring the source is not restoring the artifact.
  rebuild();
  console.log('\n# restored (source and dist)');
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
