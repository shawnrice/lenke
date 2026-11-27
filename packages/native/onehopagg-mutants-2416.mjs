/**
 * DOES `onehopagg-oracle-2416.ts` HAVE TEETH? The mutation run, because it passed on its first
 * attempt and so does a test that checks nothing.
 *
 * CLAUDE.md's rule, verbatim: *"Mutate it and check the fuzzer catches it. It passed on its first
 * run, and so does a test that checks nothing. [...] A generative test whose teeth were never
 * verified is worse than no test, because it is believed."*
 *
 * EVERY MUTANT IS APPLIED TO A PRISTINE COPY AND RESTORED BEFORE THE NEXT ONE, never only after the
 * loop: an interrupted loop otherwise leaves the mutant in the tree and `git diff` is the only thing
 * between it and a commit. The pristine copy lives under `target/` (gitignored, and it survives the
 * reboot a runaway mutant may force) rather than in a scratch directory that a reboot wipes.
 *
 * EVERY MUTANT RUNS UNDER A TIMEOUT AND A MEMORY CAP, because a mutant is arbitrary broken code and
 * can hang or allocate without bound. Exit 124 (timeout) and 137 (OOM kill) ARE the mutant being
 * caught, not harness failures.
 *
 * AND A VERDICT NEEDS EVIDENCE OF EXECUTION, not an exit code: both streams are concatenated, the
 * oracle's own result line is looked for there, and only then is the exit code read. `bun` writes to
 * stderr for some of this and stdout for the rest, and a check that reads one stream is blind to the
 * other - items 767 and 772-773 are both instances.
 *
 * EXPECTED SURVIVORS ARE LABELLED `[EQUIV]` WITH A REASON. A mutant that only strips a ROUTE is
 * answer-equivalent by design: the query falls to a slower path and returns the same rows, which is
 * `perf-gate-needs-its-own-test` and is exactly what this oracle cannot and should not catch.
 *
 *     node onehopagg-mutants-2416.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const TARGET = '../gql/src/executor/hop-projection.ts';
const PRISTINE = '../../target/mutants-2416/hop-projection.ts';

mkdirSync('../../target/mutants-2416', { recursive: true });
copyFileSync(TARGET, PRISTINE);

/** `[label, find, replace]`, each `find` asserted to occur EXACTLY ONCE before it is used. */
const MUTANTS = [
  [
    'sum fold starts at 1 instead of 0 (an off-by-one in every sum)',
    '  init: () => 0,',
    '  init: () => 1,',
  ],
  [
    'sum fold ignores the value, so every sum answers its init',
    '    return (acc as number) + v;',
    '    return acc as number;',
  ],
  [
    'sum fold drops its non-number guard, so a null concatenates instead of faulting',
    '    if (typeof v !== '.concat(
      "'number') {\n      throw NOT_PLAIN_NUMBERS;\n    }\n\n    return (acc as number) + v;",
    ),
    '    return (acc as number) + (v as number);',
  ],
  [
    '[EQUIV] renaming the synthetic value column — ONE const serves both the write and the read-back, ' +
      'so a rename cannot break the pairing. Mislabelled as a real mutant on the first run.',
    "  const VALUE_COL = ' hopagg';",
    "  const VALUE_COL = ' hopagg2';",
  ],
  [
    '[EQUIV] sum loses its fold and falls to the collecting arm — a ROUTE change, same answer',
    "  return pct?.name === 'sum' ? SUM_FOLD : undefined;",
    '  return undefined;',
  ],
  [
    '[EQUIV] the NO-OP control — if this one is reported CAUGHT the harness is broken',
    'const SUM_FOLD: AggFold = {',
    'const SUM_FOLD: AggFold = {\n  // no-op control\n',
  ],
];

const restore = () => copyFileSync(PRISTINE, TARGET);

let caught = 0;
let survived = 0;
const lines = [];

for (const [label, find, replace] of MUTANTS) {
  restore();

  const src = readFileSync(TARGET, 'utf8');
  const n = src.split(find).length - 1;

  if (n !== 1) {
    lines.push(`  ANCHOR ${String(n)}x — SKIPPED (not unique): ${label}`);
    continue;
  }

  writeFileSync(TARGET, src.replace(find, replace));

  // The mutant must actually be in the tree: a failed write would run the PRISTINE code and report
  // every mutant as surviving, which reads like a toothless oracle rather than a broken harness.
  if (!readFileSync(TARGET, 'utf8').includes(replace.trim().split('\n')[0])) {
    throw new Error(`mutant did not apply: ${label}`);
  }

  let out = '';
  let code = 0;

  try {
    out = execFileSync(
      'timeout',
      [
        '600',
        'systemd-run',
        '--user',
        '--scope',
        '-q',
        '-p',
        'MemoryMax=16G',
        '-p',
        'MemorySwapMax=0',
        'bun',
        'onehopagg-oracle-2416.mjs',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // BOTH streams, then the code — never one stream.
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? -1;
  }

  const ran = out.includes('agg-vs-rows:');
  const timedOut = code === 124 || code === 137;
  const hit = timedOut || (ran && code !== 0);
  let detail;

  if (timedOut) {
    detail = `exit ${String(code)} (timeout/OOM IS the catch)`;
  } else if (ran) {
    const agg = (out.match(/# agg-vs-rows:.*/)?.[0] ?? '').trim();
    const route = (out.match(/# ROUTE INVARIANCE.*/)?.[0] ?? '').trim();

    detail = `${agg} | ${route}`;
  } else {
    detail = `DID NOT RUN (code ${String(code)}) — a compile error counts as caught only if the oracle is what failed`;
  }

  if (hit) {
    caught += 1;
  } else {
    survived += 1;
  }

  lines.push(`  ${hit ? 'CAUGHT  ' : 'SURVIVED'} ${label}\n             ${detail}`);
}

restore();

if (readFileSync(TARGET, 'utf8') !== readFileSync(PRISTINE, 'utf8')) {
  throw new Error('RESTORE FAILED — the tree still holds a mutant');
}

console.log(
  `# ${String(MUTANTS.length)} mutants: ${String(caught)} caught / ${String(survived)} survived`,
);
console.log('# tree restored and verified byte-identical to the pristine copy');

for (const l of lines) {
  console.log(l);
}
