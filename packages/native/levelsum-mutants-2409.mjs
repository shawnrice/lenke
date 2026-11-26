// Item 2409 — DOES THE SUITE CATCH A BROKEN MULTIPLICITY-WEIGHTED FOLD?
//
// The rung is answer-equivalent to the general path up to item 2401's precision bound, which is
// exactly the shape where a green suite says nothing: `[[perf-gate-needs-its-own-test]]`. So the
// mutants below attack BOTH halves — the arithmetic (which `chain-levels-weighted-sum.test.ts` must
// catch) and the ROUTE (which only `routes-fired.test.ts` can).
//
// A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` / `N fail`
// to STDERR, never stdout. Items 767 and 772-773 each got this wrong in opposite directions, so the
// runner concatenates both streams, finds a result line there, and only then reads the exit code.
//
// AND EVERY MUTANT RUNS UNDER A TIMEOUT AND A MEMORY CAP. A mutant is arbitrary broken code: the
// weighted loop has a `continue` in it and the bail returns a sentinel, so a mutant can loop forever
// or fall through to a general path that materializes every row. Exit 124 or 137 IS the catch.
//
//     bun levelsum-mutants-2409.mjs
//     ONLY=3 bun levelsum-mutants-2409.mjs      # one mutant, by index
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(ROOT, 'packages/gql/src/executor/chain-fold-levels.ts');
// UNDER `target/`, which is gitignored AND survives the reboot a runaway mutant may force. The
// scratchpad does not: CLAUDE.md records a pristine copy lost to exactly that and reconstructed by
// hand from `git diff`.
const PRISTINE_DIR = resolve(ROOT, 'target/mutants-2409');
const PRISTINE = resolve(PRISTINE_DIR, 'chain-fold-levels.ts');

mkdirSync(PRISTINE_DIR, { recursive: true });
copyFileSync(SRC, PRISTINE);

const TESTS = ['src/chain-levels-weighted-sum.test.ts', 'src/routes-fired.test.ts'];

/**
 * Each mutant is `[label, from, to]`, applied by exact string replacement.
 *
 * EVERY ANCHOR IS COUNTED BEFORE IT IS USED. `[[ambiguous-anchor-strings]]`: item 2408 lost a
 * whole A/B run and had two mutants silently edit the wrong function because a line that had been
 * unique became ambiguous once the change itself was applied.
 */
const MUTANTS = [
  // ---------------------------------------------------------------- the ROUTE
  [
    'the weighted fusion is never taken',
    "const WEIGHTED: ReadonlySet<string> = new Set(['sum', 'avg']);",
    'const WEIGHTED: ReadonlySet<string> = new Set([]);',
  ],
  /*
   * THIS ANCHOR MOVED. The first version mutated `if (distinct && name !== 'count')`, which
   * SURVIVED — and that was the mutant being unreachable, not a coverage gap: `!node.distinct` in
   * the `weighted` gate keeps a DISTINCT sum out before that line is ever consulted. So the mutant
   * now attacks the gate that actually guards it, which is the reachable one.
   */
  /*
   * THIS MUTANT REMOVES BOTH GATES, AND THE REASON IS WORTH RECORDING. A DISTINCT sum is
   * kept off this rung TWICE — by `!node.distinct` in the `weighted` gate and by
   * `distinct && name !== 'count'` below it. The first two versions of this mutant removed ONE of
   * them, and SURVIVED both times: the remaining gate declined the shape, so the engine caught the
   * mutant and no test had to. That reads as a coverage gap and is not one. Removing both makes the
   * redundancy reachable, which is the only way a test can speak for it.
   */
  [
    'BOTH gates against a DISTINCT sum are removed',
    `    !node.distinct &&
    node.args.length === 1`,
    `    node.args.length === 1`,
    `  if (distinct && name !== 'count') {
    return null;
  }`,
    `  if (!distinct && name !== 'count') {
    return null;
  }`,
  ],
  // ---------------------------------------------------------- the ARITHMETIC
  ['the multiplicity weight is dropped from the sum', 'total += mult * cell;', 'total += cell;'],
  [
    'the multiplicity weight is dropped from the DENOMINATOR only',
    `      total += mult * cell;
      weight += mult;`,
    `      total += mult * cell;
      weight += 1;`,
  ],
  /*
   * THIS ONE WAS A NO-OP AND SURVIVED, which is item 1918's battery defect repeated. It read
   * `total / (weight > 0 ? weight : 1)` — identical to `total / weight` on the only path that
   * reaches it, since `have` is true exactly when `weight >= 1`. It read as a coverage gap in the
   * denominator. Replaced with an off-by-one that actually moves the answer.
   */
  [
    "avg's denominator is off by one",
    "    return name === 'sum' ? total : total / weight;",
    "    return name === 'sum' ? total : total / (weight + 1);",
  ],
  [
    'an empty weighted fold answers 0 instead of null',
    `    if (!have) {
      return null;
    }

    return name === 'sum' ? total : total / weight;`,
    `    if (!have) {
      return 0;
    }

    return name === 'sum' ? total : total / weight;`,
  ],
  [
    'sum and avg are swapped',
    "    return name === 'sum' ? total : total / weight;",
    "    return name === 'avg' ? total : total / weight;",
  ],
  // ---------------------------------------------------------------- the BAIL
  [
    'the non-number bail never fires',
    `      if (typeof cell !== 'number') {
        return WEIGHTED_BAIL;
      }`,
    `      if (false) {
        return WEIGHTED_BAIL;
      }`,
  ],
  [
    'the bail returns the PARTIAL TOTAL instead of handing the query back',
    `      if (typeof cell !== 'number') {
        return WEIGHTED_BAIL;
      }`,
    `      if (typeof cell !== 'number') {
        return total;
      }`,
  ],
  /*
   * THIS ANCHOR ALSO MOVED, AND THE REASON IS THE ITEM'S SECOND CORRECTION OF ITSELF. The
   * first version relaxed `!Number.isFinite(cell)` to `typeof cell !== 'number'` and SURVIVED — and
   * `levelsum-inf-probe-2409.mjs` then showed the two are answer-equivalent on all six non-finite
   * and overflow fixtures, so that mutant could not be caught by any test. The guard shipped is now
   * the `typeof` one, and the mutant attacks the half that IS load-bearing: letting a NON-NUMBER
   * through, where `u · Temporal` is a silent `NaN` and the engine owes a fault.
   */
  [
    'the bail lets a non-number through',
    "if (typeof cell !== 'number') {",
    'if (cell === undefined) {',
  ],
  [
    'the caller ignores the bail and answers the sentinel',
    '    return value === WEIGHTED_BAIL ? null : [{ [outName]: value }];',
    '    return [{ [outName]: value }];',
  ],
  // ------------------------------------------------------------- null handling
  [
    'a null value is counted with weight but no addend',
    `    if (cell === null || cell === undefined) {
      continue;
    }`,
    `    if (cell === null || cell === undefined) {
      weight += mult;
      continue;
    }`,
  ],
  // --------------------------------------------- the per-level label mask
  [
    'the weighted arm reads the multiplicity BEFORE the zero check',
    `    const mult = u[v];

    if (mult === 0) {
      continue;
    }`,
    `    const mult = u[v] === 0 ? 1 : u[v];

    if (false) {
      continue;
    }`,
  ],
  // ---------------------------------------------------- a NO-OP CONTROL
  /*
   * **THE CONTROL THAT MAKES A CLEAN SWEEP MEAN SOMETHING, and item 2408 is why it is here.**
   * Item 1918's battery carried a mutant that replaced `count += 1` with `count = count + 1 + 0` —
   * the SAME arithmetic. It survived, and read as a coverage gap in the fold rather than a defect in
   * the battery. This one is deliberately a no-op and is EXPECTED to survive: if it does not, the
   * harness is reporting something other than the mutation.
   */
  [
    'CONTROL (expected to survive): the weight is multiplied by one',
    'total += mult * cell;',
    'total += mult * 1 * cell;',
  ],
];

const NO_OP = MUTANTS.length - 1;
const only = process.env.ONLY === undefined ? undefined : Number(process.env.ONLY);
const pristine = readFileSync(PRISTINE, 'utf8');
const results = [];

for (const [i, [label, ...edits]] of MUTANTS.entries()) {
  if (only !== undefined && only !== i) {
    continue;
  }

  // RESTORE BEFORE APPLYING, never only after the loop: an interrupted run otherwise leaves the
  // mutant in the tree with `git diff` as the only thing between it and a commit.
  writeFileSync(SRC, pristine);

  // A mutant may carry MORE THAN ONE edit, as `[from, to, from, to, ...]` — needed where a property
  // is guarded by two gates in series and removing one leaves the other, so a single-edit mutant is
  // caught by the engine rather than by a test.
  const pairs = [];

  for (let k = 0; k < edits.length; k += 2) {
    pairs.push([edits[k], edits[k + 1]]);
  }

  const bad = pairs.find(([from]) => pristine.split(from).length - 1 !== 1);

  if (bad !== undefined) {
    const n = pristine.split(bad[0]).length - 1;

    results.push({
      i,
      label,
      verdict: `ANCHOR x${n}`,
      detail: `not applied: ${bad[0].slice(0, 60)}`,
    });
    console.log(`${String(i).padStart(2)} ANCHOR x${n}  ${label}`);
    continue;
  }

  let mutated = pristine;

  for (const [from, to] of pairs) {
    mutated = mutated.replace(from, to);
  }

  writeFileSync(SRC, mutated);

  // ASSERT THE MUTANT APPLIED. A `cp` that silently did nothing is a null that looks like a result.
  const after = readFileSync(SRC, 'utf8');

  if (pairs.some(([from, to]) => !after.includes(to) || after.includes(from))) {
    results.push({ i, label, verdict: 'NOT APPLIED', detail: 'string replace did not stick' });
    continue;
  }

  const build = spawnSync('bun', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });

  if (build.status !== 0) {
    // A mutant that will not compile IS caught — the typechecker is part of the suite.
    results.push({ i, label, verdict: 'CAUGHT (build)', detail: 'did not compile' });
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

writeFileSync(SRC, pristine);

const build = spawnSync('bun', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });

console.log(`\nrestored pristine; rebuild exit ${build.status}`);

const unexpected = results.filter(
  (r) => (r.verdict === 'SURVIVED') !== (r.i === NO_OP) || r.verdict.startsWith('ANCHOR'),
);
const caught = results.filter((r) => r.verdict.startsWith('CAUGHT')).length;

console.log(
  `\n${caught}/${results.length - (only === undefined ? 1 : 0)} real mutants CAUGHT  ` +
    `(index ${NO_OP} is the no-op control and SHOULD survive)`,
);

if (unexpected.length > 0) {
  console.log('\nUNEXPECTED:');

  for (const r of unexpected) {
    console.log(`  ${r.i} ${r.verdict}  ${r.label}\n     ${r.detail}`);
  }

  process.exitCode = 1;
}
