/**
 * DOES THE VAR-LENGTH COUNT SEED GATE HAVE TEETH? (item 1907)
 *
 * ⚠️⚠️ THE SUBJECT IS ARITHMETIC, NOT A WALK. This rung counts paths with degree products, a level
 * recurrence and closed-form trail corrections — so a seed gate that admits the wrong sources gives
 * a WRONG NUMBER with no row to inspect. The mutants therefore target the gate's placement as much
 * as its content: a gate applied after a term is counted, or to one source list and not the other,
 * is the failure mode.
 *
 * ⚠️ NATIVE IS IN THE TEST SET because it has carried a seed mask since item 575 and is the
 * reference implementation for this exact question; `varlen-degree-count.test.ts` is item 573's own
 * suite, so a mutant that breaks the UNSEEDED arithmetic still has somewhere to fail.
 *
 *     bun sort-gate-mutants-1902.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { vlc: `${ROOT}/packages/gql/src/executor/var-length-count.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1907b`;
const TESTS = [
  'src/varlen-seed-route.test.ts',
  'src/trail-count-bruteforce.test.ts',
  'src/landing-pred-degree-count.test.ts',
  'src/trail-three-hop-count.test.ts',
  'src/varlen-depth4-vacuous.test.ts',
];

/** `[name, which, from, to, expectedOccurrences, occurrence?]` */
const MUTANTS = [
  [
    'the seed gate is never consulted — depth<=2 arm',
    'vlc',
    `if (seedPasses !== undefined && !seedPasses(s)) {
      continue;
    }`,
    '',
    1,
  ],
  [
    'the seed gate is inverted — depth<=2 arm',
    'vlc',
    'if (seedPasses !== undefined && !seedPasses(s)) {',
    'if (seedPasses !== undefined && seedPasses(s)) {',
    1,
  ],
  [
    'the LEVEL arm ignores the seed gate',
    'vlc',
    'const src = seedPasses === undefined ? unfiltered : unfiltered.filter((v) => seedPasses(v));',
    'const src = unfiltered;',
    1,
  ],
  [
    'the LEVEL arm filters by the ENDPOINT test instead of the seed one',
    'vlc',
    'const src = seedPasses === undefined ? unfiltered : unfiltered.filter((v) => seedPasses(v));',
    'const src = unfiltered.filter((v) => passes(v));',
    1,
  ],
  [
    'a start predicate is refused again (the pre-1907 behaviour)',
    'vlc',
    'if (startPred === null) {',
    'if (startPred !== undefined) {',
    1,
  ],
  [
    'the start gate is built from the ENDPOINT node',
    'vlc',
    `const startPred = gateWith(
    pattern.start,`,
    `const startPred = gateWith(
    node,`,
    1,
  ],
  [
    'the start gate reads the ENDPOINT variable conjuncts',
    'vlc',
    'pattern.start.variable === undefined ? undefined : gates?.get(pattern.start.variable),',
    'node.variable === undefined ? undefined : gates?.get(node.variable),',
    1,
  ],
  [
    'the predicate-free closure claims a start-predicate query',
    'vlc',
    'if (endPred === undefined && startPred === undefined) {',
    'if (endPred === undefined) {',
    1,
  ],
  ['the spec drops the seed gate', 'vlc', '          seedPasses,\n', '', 1],
];

/** Names that MUST survive, each with its reason stated at the entry. */
const EXPECTED_SURVIVORS = new Set();

/*
 * ⚠️⚠️ AND ONE ENTRY WAS REMOVED FROM THIS SET BECAUSE THE HARNESS CONTRADICTED IT. Reverting the
 * change is ANSWER-EQUIVALENT — the old route returns the same rows, slower — so it was declared an
 * expected survivor on [[perf-gate-needs-its-own-test]] grounds. It is CAUGHT, by the ROUTE
 * assertions in `unwindowed-expr-sort.test.ts`, and the harness said so ("was expected to SURVIVE
 * and did not — update the entry"). That is the rule working in the direction nobody checks.
 */

/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/**
 * ⚠️ BOTH STREAMS, ALWAYS: `bun test` writes `N pass` to **stderr**, and item 767 read an empty
 * stdout and concluded the runner never ran a test.
 */
/**
 * ⚠️⚠️ **BOTH PACKAGES, AND THE MUTATION RUN IS WHY.** The gql-side tests cover the pure gate
 * function; three mutants of the RUN-TIME seed gate — admitting every vertex, admitting an UNKNOWN
 * result, never consulting it — all SURVIVED a gql-only run, because the answers that can see them
 * are the cross-engine ones in `packages/native`. A battery whose test set cannot reach the code it
 * mutates reports teeth it does not have.
 */
/*
 * ⚠️⚠️ **THREE TIMES THIS SESSION A TEMPLATED BATTERY SILENTLY TESTED THE WRONG SUBJECT**, and all
 * three were config fields a slice-based `replace` never reached: the `cwd`, the `SRCS` path, and
 * this list — which still named item 1906's parity test, so two real mutants reported SURVIVED
 * against a suite that cannot see them. ⚠️ The fix is mechanical: assert every intended replacement
 * matched exactly once, over the WHOLE file, rather than over a slice of it. A battery is a
 * measuring instrument and its own configuration is the first thing to verify.
 */
const NATIVE_TESTS = ['src/varlen-seed-gate-parity.test.ts', 'src/varlen-degree-count.test.ts'];

/**
 * ⚠️⚠️ **THE DIST MUST BE REBUILT PER MUTANT, and the mutation run is what exposed that too.**
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
  // ⚠️ EITHER failing is a catch, so the codes are combined rather than one being read.
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
      console.log(`  ⚠️ DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
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

    // ⚠️ THE `N failing` COUNT IS THE GQL RUN'S, because the regex takes the first result line in
    // the concatenated output. A mutant caught only by the NATIVE suite therefore prints
    // `0 failing` beside a ✅ — the verdict comes from the exit code, which is the contract
    // (CLAUDE.md: concatenate both streams, find a result line, THEN read the code).
    console.log(
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  // ⚠️ AND REBUILD, or the finally leaves the LAST MUTANT in the dist that every TS harness reads.
  // Restoring the source is not restoring the artifact.
  rebuild();
  console.log('\n# restored (source and dist)');
}

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
