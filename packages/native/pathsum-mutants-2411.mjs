// Item 2411 — DOES THE SUITE CATCH A BROKEN PER-PATH `sum`/`avg` FOLD?
//
// This rung is ANSWER-EQUIVALENT to the general path up to item 2401's precision bound, which is
// exactly the shape where a green suite says nothing (`[[perf-gate-needs-its-own-test]]`). So the
// mutants below attack BOTH halves — the arithmetic (which `chain-path-sum.test.ts` must catch) and
// the ROUTE (which only `routes-fired.test.ts` can).
//
// THREE MUTANTS ARE EXPECTED TO SURVIVE AND ARE LABELLED `[EQUIV]`. Each is answer-equivalent for
// a reason stated at its entry, not a coverage gap — item 2409's battery spent three iterations on
// defective mutants (one UNREACHABLE, one a NO-OP, one answer-equivalent) before noticing that
// predicting the verdict is part of writing the mutant.
//
// A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` / `N fail`
// to STDERR, never stdout. Items 767 and 772-773 each got this wrong in opposite directions, so the
// runner concatenates both streams, finds a result line there, and only then reads the exit code.
//
// AND EVERY MUTANT RUNS UNDER A TIMEOUT AND A MEMORY CAP. A mutant is arbitrary broken code, and
// a rung that declines falls through to a path that materializes every row. Exit 124 or 137 IS the
// catch.
//
//     bun pathsum-mutants-2411.mjs
//     ONLY=3 bun pathsum-mutants-2411.mjs      # one mutant, by index
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

const FOLD = 'packages/gql/src/executor/path-sum-fold.ts';
const CHAIN = 'packages/gql/src/executor/chain-projection.ts';
const HOP2 = 'packages/gql/src/executor/hop2-projection.ts';

// UNDER `target/`, which is gitignored AND survives the reboot a runaway mutant may force. The
// scratchpad does not: CLAUDE.md records a pristine copy lost to exactly that.
const PRISTINE_DIR = resolve(ROOT, 'target/mutants-2411');

mkdirSync(PRISTINE_DIR, { recursive: true });

const pristineOf = new Map();

for (const rel of [FOLD, CHAIN, HOP2]) {
  const src = resolve(ROOT, rel);
  const copy = resolve(PRISTINE_DIR, basename(rel));

  copyFileSync(src, copy);
  pristineOf.set(rel, readFileSync(copy, 'utf8'));
}

const TESTS = [
  'src/chain-path-sum.test.ts',
  'src/routes-fired.test.ts',
  'src/chain-levels-near-arg.test.ts',
  'src/chain-levels-weighted-sum.test.ts',
];

const GATE =
  'const sumAgg = folded === undefined ? pathSumAggFor(proj, ret.projection.items[0]?.expr) : null;';

/**
 * Each mutant is `[label, file, from, to, …]` — a file plus one or more exact string replacements.
 *
 * EVERY ANCHOR IS COUNTED BEFORE IT IS USED (`[[ambiguous-anchor-strings]]`). The gate line is
 * textually IDENTICAL in the two rungs, so a mutant naming the wrong file would silently measure the
 * other width — the per-file pristine copy is what makes the count meaningful.
 */
const MUTANTS = [
  // --- the arithmetic ----------------------------------------------------------------------
  [
    'an empty sum answers null (item 2409s divergence, restored)',
    FOLD,
    "return [{ [outName]: name === 'sum' ? 0 : null }];",
    'return [{ [outName]: null }];',
  ],
  [
    'an empty avg answers 0',
    FOLD,
    "return [{ [outName]: name === 'sum' ? 0 : null }];",
    'return [{ [outName]: 0 }];',
  ],
  [
    'avg divides by the PATH count, not the non-null count',
    FOLD,
    "return [{ [outName]: name === 'sum' ? total : total / count }];",
    "return [{ [outName]: name === 'sum' ? total : total / inner.length }];",
  ],
  [
    'avg denominator is off by one',
    FOLD,
    "return [{ [outName]: name === 'sum' ? total : total / count }];",
    "return [{ [outName]: name === 'sum' ? total : total / (count + 1) }];",
  ],
  ['the sum accumulates with the wrong sign', FOLD, 'total += v;', 'total -= v;'],
  [
    'the bail admits a non-number, so a stored temporal is summed',
    FOLD,
    "if (typeof v !== 'number') {",
    'if (false) {',
  ],
  // --- the gate ----------------------------------------------------------------------------
  [
    'the gate admits sum(DISTINCT), which this accumulator cannot dedup',
    FOLD,
    '    item.distinct ||\n',
    '    false ||\n',
  ],
  [
    'the gate requires two arguments, so nothing is admitted (a ROUTE mutant)',
    FOLD,
    'item.args.length !== 1',
    'item.args.length !== 2',
  ],
  // --- the route, per rung -----------------------------------------------------------------
  [
    'the THREE-PLUS-HOP rung never offers the fold (a ROUTE mutant)',
    CHAIN,
    GATE,
    'const sumAgg = folded === undefined && false ? pathSumAggFor(proj, ret.projection.items[0]?.expr) : null;',
  ],
  [
    'the TWO-HOP rung never offers the fold (a ROUTE mutant)',
    HOP2,
    GATE,
    'const sumAgg = folded === undefined && false ? pathSumAggFor(proj, ret.projection.items[0]?.expr) : null;',
  ],
  // --- expected survivors, each for a stated reason ----------------------------------------
  /*
   * [EQUIV] Removing the nullish skip does not let a null through — `typeof null !== 'number'` then
   * BAILS, the rung declines, and the general path answers correctly. So the two arms agree on every
   * fixture and no assertion can separate them. The guard earns its place by keeping the fold on a
   * null-bearing column rather than by changing an answer.
   */
  [
    '[EQUIV] the nullish skip is removed (the bail then catches null)',
    FOLD,
    'if (v === null || v === undefined) {',
    'if (false) {',
  ],
  /*
   * [EQUIV] `foldFor` returns a fold ONLY for `count`, `count(DISTINCT)`, `min` and `max`, so every
   * name reaching the `foldedAggs` path is already order-invariant and the allowlist is redundant
   * today. Item 1830 recorded exactly this: two mutants on that set survive. It is kept as the guard
   * against a change someone is now MOTIVATED to make.
   */
  [
    '[EQUIV] the order-invariant allowlist is dropped from the gate',
    CHAIN,
    '(folded !== undefined && !ORDER_INVARIANT_AGGREGATES.has(folded.expr.name)) ||',
    'false ||',
  ],
  /*
   * [EQUIV] The deliberate NO-OP control. `1 * v` is `v`, so a battery reporting this as CAUGHT is
   * reporting its own noise and every other verdict in the run is suspect.
   */
  ['[EQUIV] NO-OP CONTROL: multiply the addend by one', FOLD, 'total += v;', 'total += 1 * v;'],
];

const only = process.env.ONLY === undefined ? undefined : Number(process.env.ONLY);
const results = [];

const restoreAll = () => {
  for (const [rel, text] of pristineOf) {
    writeFileSync(resolve(ROOT, rel), text);
  }
};

for (const [i, [label, file, ...edits]] of MUTANTS.entries()) {
  if (only !== undefined && only !== i) {
    continue;
  }

  // RESTORE BEFORE APPLYING, never only after the loop: an interrupted run otherwise leaves the
  // mutant in the tree with `git diff` as the only thing between it and a commit.
  restoreAll();

  const pristine = pristineOf.get(file);
  const src = resolve(ROOT, file);
  const pairs = [];

  for (let k = 0; k < edits.length; k += 2) {
    pairs.push([edits[k], edits[k + 1]]);
  }

  const bad = pairs.find(([from]) => pristine.split(from).length - 1 !== 1);

  if (bad !== undefined) {
    const n = pristine.split(bad[0]).length - 1;

    results.push({ i, label, verdict: `ANCHOR x${n}`, detail: bad[0].slice(0, 60) });
    console.log(`${String(i).padStart(2)} ANCHOR x${n}  ${label}\n     ${bad[0].slice(0, 70)}`);
    continue;
  }

  let mutated = pristine;

  for (const [from, to] of pairs) {
    mutated = mutated.replace(from, to);
  }

  writeFileSync(src, mutated);

  // ASSERT THE MUTANT APPLIED. A write that silently did nothing is a null that looks like a result.
  const after = readFileSync(src, 'utf8');

  if (pairs.some(([, to]) => !after.includes(to))) {
    results.push({ i, label, verdict: 'NOT APPLIED', detail: 'string replace did not stick' });
    console.log(`${String(i).padStart(2)} NOT APPLIED  ${label}`);
    continue;
  }

  const build = spawnSync('bun', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });

  if (build.status !== 0) {
    // A mutant that will not compile IS caught — the typechecker is part of the suite.
    results.push({ i, label, verdict: 'CAUGHT (build)', detail: 'did not compile' });
    console.log(`${String(i).padStart(2)} CAUGHT (build)   ${label}`);
    continue;
  }

  const run = spawnSync(
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
      'test',
      ...TESTS,
    ],
    { cwd: resolve(ROOT, 'packages/gql'), encoding: 'utf8' },
  );
  // BOTH STREAMS, then the exit code — see the header.
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const result = /(\d+) pass\s+(\d+) fail/.exec(out);
  const code = run.status;

  let verdict;
  let detail;

  if (code === 124) {
    verdict = 'CAUGHT (timeout)';
    detail = 'exit 124 — a mutant that cannot terminate is one the test would have caught';
  } else if (code === 137) {
    verdict = 'CAUGHT (OOM)';
    detail = 'exit 137 — killed at the 16G cap';
  } else if (result === null) {
    verdict = 'DID NOT RUN';
    detail = `no result line on either stream; exit ${code}`;
  } else if (Number(result[2]) > 0) {
    verdict = 'CAUGHT';
    detail = `${result[2]} fail of ${Number(result[1]) + Number(result[2])}`;
  } else {
    verdict = 'SURVIVED';
    detail = `${result[1]} pass, 0 fail`;
  }

  results.push({ i, label, verdict, detail });
  console.log(`${String(i).padStart(2)} ${verdict.padEnd(16)} ${label}\n     ${detail}`);
}

restoreAll();
spawnSync('bun', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });

const caught = results.filter((r) => r.verdict.startsWith('CAUGHT')).length;
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const expected = survived.filter((r) => r.label.startsWith('[EQUIV]')).length;

console.log(
  `\n${caught} caught, ${survived.length} survived ` +
    `(${expected} of them expected [EQUIV]), of ${results.length} run`,
);

for (const r of survived.filter((x) => !x.label.startsWith('[EQUIV]'))) {
  console.log(`UNEXPECTED SURVIVOR  ${r.i}  ${r.label}`);
}
