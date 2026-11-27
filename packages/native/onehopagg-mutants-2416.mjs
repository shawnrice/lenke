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

/*
 * TWO TARGET FILES SINCE ITEM 2420, because the one-hop foldable aggregates MOVED. They used to
 * ride `hopAggregate` in `hop-projection.ts`; they now ride `chainFoldLevels` in
 * `chain-fold-levels.ts`, and a battery pointed only at the old file would keep reporting teeth
 * while the code actually serving the shape had none. `hop-projection.ts` stays targeted because it
 * KEEPS what the level fold refuses: `collect`, a near-argument aggregate, and the percentiles.
 */
const FILES = {
  hop: '../gql/src/executor/hop-projection.ts',
  levels: '../gql/src/executor/chain-fold-levels.ts',
};

mkdirSync('../../target/mutants-2416', { recursive: true });

const PRISTINE = Object.fromEntries(
  Object.entries(FILES).map(([key, file]) => {
    const dst = `../../target/mutants-2416/${key}.ts`;

    copyFileSync(file, dst);

    return [key, dst];
  }),
);

const NOT_NUMBER_GUARD =
  "    if (typeof v !== 'number') {\n      throw NOT_PLAIN_NUMBERS;\n    }\n\n    return (acc as number) + v;";

/** `[label, fileKey, find, replace]` — each `find` asserted to occur EXACTLY ONCE before use. */
const MUTANTS = [
  [
    'sum fold starts at 1 instead of 0 (an off-by-one in every sum)',
    'hop',
    '  init: () => 0,',
    '  init: () => 1,',
  ],
  [
    'sum fold ignores the value, so every sum answers its init',
    'hop',
    '    return (acc as number) + v;',
    '    return acc as number;',
  ],
  [
    'sum fold drops its non-number guard, so a null concatenates instead of faulting',
    'hop',
    NOT_NUMBER_GUARD,
    '    return (acc as number) + (v as number);',
  ],
  // --- the LEVEL FOLD, which serves the one-hop foldable aggregates since item 2420 ---
  [
    'the level fold ignores MULTIPLICITY, so a vertex reached u times contributes once',
    'levels',
    '    const mult = u[v];',
    '    const mult = 1;',
  ],
  [
    'the level fold treats an UNREACHED vertex as reached, folding the whole label extent',
    'levels',
    '    if (mult === 0) {\n      continue;\n    }',
    '    if (false) {\n      continue;\n    }',
  ],
  [
    '[EQUIV] the one-hop admission is reverted, so the shape falls back to hopAggregate - a pure ROUTE change, which this oracle cannot and should not see (perf-gate-needs-its-own-test)',
    'levels',
    '   * and the accepted 1.3x fanout-1 trade.\n   */\n  const shape = chainShapeOf(m, 1);',
    '   */\n  const shape = chainShapeOf(m, 2);',
  ],
  // --- the DISTINCT level pass, which serves one hop since item 2423 ---
  [
    'the MULTI-COLUMN distinct key uses only the FIRST column (two columns dedupe as one)',
    'levels',
    // eslint-disable-next-line no-template-curly-in-string -- DELIBERATE: this is SOURCE TEXT to match, not a template; the `${...}` must stay literal or the anchor misses.
    '      key = i === 0 ? valueKey(cell) : `${key}\\u0001${valueKey(cell)}`;',
    '      key = i === 0 ? valueKey(cell) : key;',
  ],
  [
    '[EQUIV] the one-hop DISTINCT admission is reverted, so the shape falls back to distinctProjection - a pure ROUTE change',
    'levels',
    '   * line 1790 and `distinctProjection` at 1899, so this pass already wins when it is willing.\n   */\n  const shape = chainShapeOf(m, 1);',
    '   */\n  const shape = chainShapeOf(m, 2);',
  ],
  [
    '[EQUIV] renaming the synthetic value column - ONE const serves both the write and the read-back, so a rename cannot break the pairing. Mislabelled as a real mutant on the first run.',
    'hop',
    "  const VALUE_COL = ' hopagg';",
    "  const VALUE_COL = ' hopagg2';",
  ],
  [
    '[EQUIV] sum loses its fold and falls to the collecting arm - a ROUTE change, same answer',
    'hop',
    "  return pct?.name === 'sum' ? SUM_FOLD : undefined;",
    '  return undefined;',
  ],
  [
    '[EQUIV] the NO-OP control - if this one is reported CAUGHT the harness is broken',
    'hop',
    'const SUM_FOLD: AggFold = {',
    'const SUM_FOLD: AggFold = {\n  // no-op control\n',
  ],
];

const restore = () => {
  for (const [key, file] of Object.entries(FILES)) {
    copyFileSync(PRISTINE[key], file);
  }
};

let caught = 0;
let survived = 0;
const lines = [];

for (const [label, fileKey, find, replace] of MUTANTS) {
  restore();

  const target = FILES[fileKey];
  const src = readFileSync(target, 'utf8');
  const n = src.split(find).length - 1;

  if (n !== 1) {
    lines.push(`  ANCHOR ${String(n)}x — SKIPPED (not unique): ${label}`);
    continue;
  }

  writeFileSync(target, src.replace(find, replace));

  // The mutant must actually be in the tree: a failed write would run the PRISTINE code and report
  // every mutant as surviving, which reads like a toothless oracle rather than a broken harness.
  if (!readFileSync(target, 'utf8').includes(replace.trim().split('\n')[0])) {
    throw new Error(`mutant did not apply: ${label}`);
  }

  /*
   * BOTH CHECKERS RUN FOR EVERY MUTANT, because neither covers the other's shapes. The aggregate
   * oracle projects exactly one column (`AS v`), so a defect in the MULTI-COLUMN distinct key is
   * invisible to it; `distinct2-check-2423.ts` projects two and three columns with deliberately
   * mismatched cardinalities and checks for duplicate rows, which is the only way that defect
   * shows. A failure in EITHER is the mutant being caught.
   */
  const CHECKERS = ['onehopagg-oracle-2416.mjs', 'distinct2-check-2423.ts'];
  let out = '';
  let code = 0;

  for (const checker of CHECKERS) {
    try {
      out += execFileSync(
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
          checker,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      // BOTH streams, then the code — never one stream.
      out += `${err.stdout ?? ''}${err.stderr ?? ''}`;
      code = err.status ?? -1;
    }
  }

  const ran = out.includes('agg-vs-rows:') && out.includes('one-hop DISTINCT:');
  const timedOut = code === 124 || code === 137;
  const hit = timedOut || (ran && code !== 0);
  let detail;

  if (timedOut) {
    detail = `exit ${String(code)} (timeout/OOM IS the catch)`;
  } else if (ran) {
    const agg = (out.match(/# agg-vs-rows:.*/)?.[0] ?? '').trim();
    const d2 = (out.match(/# multi-column one-hop DISTINCT:.*/)?.[0] ?? '').trim();

    detail = `${agg} | ${d2}`;
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

for (const [key, file] of Object.entries(FILES)) {
  if (readFileSync(file, 'utf8') !== readFileSync(PRISTINE[key], 'utf8')) {
    throw new Error(`RESTORE FAILED — ${file} still holds a mutant`);
  }
}

console.log(
  `# ${String(MUTANTS.length)} mutants: ${String(caught)} caught / ${String(survived)} survived`,
);
console.log('# tree restored and verified byte-identical to the pristine copy');

for (const l of lines) {
  console.log(l);
}
