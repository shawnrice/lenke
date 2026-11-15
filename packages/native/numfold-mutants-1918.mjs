/**
 * DOES `projected-numeric-fold.test.ts` HAVE TEETH? (item 1918)
 *
 * ⚠️ THE SUBJECT IS AN ORDER-SENSITIVE REDUCE, which is what makes this different from the
 * `min`/`max` fold beside it. A mutant that keeps every value and adds them in a different ORDER is
 * a wrong answer in the last ulp — invisible to any assertion that compares rounded output, and
 * exactly the hazard items 1830/1831 declined to risk. The `fused and declined routes agree BIT FOR
 * BIT` test exists for that mutant and this battery is where it gets checked.
 *
 * ⚠️⚠️ WRITTEN DIRECTLY RATHER THAN TEMPLATED, which is item 1907's lesson: three times in one
 * session a slice-based `replace` left a config field pointing at the previous item's subject. Every
 * field here is literal, and every test path was listed from the directory rather than recalled
 * (item 1915 found a non-existent path in its own first draft).
 *
 * ⚠️ UNDER BOTH A TIMEOUT AND A CGROUP CAP — a mutant is arbitrary broken code. The net was proved
 * at item 1915: a 2G cap kills the allocator bomb by SIGNAL after 7.3 s where 16G lets bun exit 1
 * after 49.1 s (so the cap, not the runtime's own ceiling, is doing it), and a bare spin loop exits
 * 124 on the timeout `MemoryMax` never trips. Exit 124 and 137 ARE the mutant being caught.
 *
 *     bun numfold-mutants-1918.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  agg: `${ROOT}/packages/gremlin/src/executor/aggregation.ts`,
  idx: `${ROOT}/packages/gremlin/src/executor/index.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1918m`;
const CWD = `${ROOT}/packages/gremlin`;
/** Listed from the directory, not recalled. The neighbours keep the min/max twin honest. */
const TESTS = [
  'src/executor/projected-numeric-fold.test.ts',
  'src/executor/projected-aggregate.test.ts',
  'src/executor/fused-values-aggregate.test.ts',
  'src/executor/projected-fold.test.ts',
  'src/executor/hop-values-residual.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  // ---- the numeric fold ----
  [
    'a null is added as 0 instead of skipped',
    'agg',
    '  for (const v of values) {\n    if (v == null) {\n      continue;\n    }\n\n    sawNonNull = true;\n    total += asNumber(v);',
    '  for (const v of values) {\n    sawNonNull = true;\n    total += asNumber(v);',
    1,
  ],
  [
    'mean divides by EVERY value, nulls included',
    'agg',
    '    sawNonNull = true;\n    total += asNumber(v);\n    count += 1;',
    '    sawNonNull = true;\n    total += asNumber(v);\n    count = count + 1 + 0;',
    1,
  ],
  [
    'an all-null input answers 0 rather than null',
    'agg',
    "  if (!sawNonNull) {\n    return [null];\n  }\n\n  return [kind === 'sum' ? total : total / count];",
    "  return [kind === 'sum' ? total : total / count];",
    1,
  ],
  [
    'sum and mean are swapped',
    'agg',
    "  return [kind === 'sum' ? total : total / count];",
    "  return [kind === 'sum' ? total / count : total];",
    1,
  ],
  [
    'asNumber is dropped, so a numeric string concatenates',
    'agg',
    '    total += asNumber(v);',
    '    total += v;',
    1,
  ],
  [
    '⚠️ THE ADDITION ORDER IS REVERSED (a last-ulp wrong answer)',
    'agg',
    '  let total = 0;\n  let count = 0;\n  let sawNonNull = false;\n\n  for (const v of values) {',
    '  let total = 0;\n  let count = 0;\n  let sawNonNull = false;\n\n  for (const v of [...values].reverse()) {',
    1,
  ],
  // ---- the gate ----
  [
    'the gate admits any terminal kind',
    'agg',
    "  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {\n    return undefined;\n  }",
    '',
    1,
  ],
  [
    'the gate admits a residual of any length',
    'agg',
    "  if (rest.length !== 1) {\n    return undefined;\n  }\n\n  const [step] = rest;\n  const { kind } = step;\n\n  if (kind !== 'min'",
    "  const [step] = rest;\n  const { kind } = step;\n\n  if (kind !== 'min'",
    1,
  ],
  [
    'the gate admits a NON-GLOBAL scope',
    'agg',
    "  if ('scope' in step && step.scope !== undefined && step.scope !== 'global') {\n    return undefined;\n  }",
    '',
    1,
  ],
  // ---- the dispatch wiring ----
  [
    'sum/mean are folded by the MIN/MAX fold',
    'idx',
    "    return folded === 'sum' || folded === 'mean'\n      ? foldProjectedNumeric(projected.values, folded)\n      : foldProjectedMinMax(projected.values, folded);",
    '    return foldProjectedMinMax(projected.values, folded);',
    1,
  ],
  [
    'min/max are folded by the NUMERIC fold',
    'idx',
    "    return folded === 'sum' || folded === 'mean'\n      ? foldProjectedNumeric(projected.values, folded)\n      : foldProjectedMinMax(projected.values, folded);",
    '    return foldProjectedNumeric(projected.values, folded);',
    1,
  ],
  [
    'the sum/mean fusion is never taken (the pre-1918 route)',
    'agg',
    "  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {",
    "  if (kind !== 'min' && kind !== 'max') {",
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ ROUTE-ONLY: declining the fusion sends `values(k).sum()` back through the generic residual,
   * which answers the SAME f64 in the SAME order — that equality is the whole point of the item, so
   * by construction no answer test can see the route. Its gates are the two instruments:
   * `gremlin-route-screen.mjs`'s `agg: hop values sum` row (`generic, 1 applyStep call [sum]`
   * before, `SHORTCUT, 0` after) and `minmax-prof-1918.mjs` (177.03 -> 71.30 ms, three controls
   * flat across 3 interleaved rounds). [[perf-gate-needs-its-own-test]].
   */
  'the sum/mean fusion is never taken (the pre-1918 route)',
]);

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/** 124 is the timeout firing and 137 the cgroup killing; both are the mutant being caught. */
const HOW_DIED = new Map([
  [124, ' — timed out'],
  [137, ' — OOM-killed'],
]);

const verdictOf = (code) => {
  if (code === 124) {
    return 'TIMEOUT (caught)';
  }

  if (code === 137) {
    return 'OOM (caught)';
  }

  return code !== 0;
};

/** ⚠️ BOTH STREAMS CONCATENATED, THEN the exit code: `bun test` reports to STDERR (item 767). */
const runTests = () => {
  const r = spawnSync(
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
    { cwd: CWD, encoding: 'utf8' },
  );

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

/*
 * ⚠️ THE CHANGE THIS BATTERY TESTS WAS REVERTED, and the battery is kept rather than deleted
 * because the work it represents is the evidence a decision needs. Item 1918 built the `sum`/`mean`
 * fusion, measured it at 2.48x/2.42x with 12/12 bit-identical agreement against the Rust engine —
 * and then found that the refusal it overturns is locked in by a TEST
 * (`projected-aggregate.test.ts`'s "sum and mean are NOT folded"), not merely by a comment. Items
 * 1830/1831 declined this trade deliberately, so it is the owner's call and the change is not
 * shipped.
 *
 * This exits 0 and explains itself when the fold is absent, so it can never fail a sweep; if the
 * change is ever taken, it runs as written.
 */
if (!readFileSync(SRCS.agg, 'utf8').includes('foldProjectedNumeric')) {
  console.log(
    'the sum/mean fusion is NOT present in aggregation.ts — item 1918 was reverted pending an ' +
      'owner decision, so this battery has nothing to mutate. See docs/reviews/CLOSED.md item 1918.',
  );
  process.exit(0);
}

for (const [key, path] of Object.entries(SRCS)) {
  copyFileSync(path, `${PRISTINE}-${key}.ts`);
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(SRCS)) {
    copyFileSync(`${PRISTINE}-${key}.ts`, path);
  }
};

const survivors = [];
/** Anchors whose occurrence count has drifted — reported TOGETHER (item 1914's harness fix). */
const anchorProblems = [];

try {
  const base = runTests();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-900)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      anchorProblems.push(`"${name}" [${which}] matched ${String(seen)}, expected ${String(want)}`);
      continue;
    }

    writeFileSync(SRCS[which], pristine.replace(from, to));

    const r = runTests();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text) || /\d+ fail/.test(r.text);

    if (!ran && r.code !== 124 && r.code !== 137) {
      console.log(`  ⚠️ DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-500)}`);
      survivors.push(`${name} (no result line)`);
      continue;
    }

    const caught = verdictOf(r.code);
    const expected = EXPECTED_SURVIVORS.has(name);

    if (caught === false && !expected) {
      survivors.push(name);
    }

    if (caught !== false && expected) {
      survivors.push(`${name} (was expected to SURVIVE and did not — update the entry)`);
    }

    const failing = result === null ? '' : `${result[2]} failing`;
    const how = HOW_DIED.get(r.code) ?? '';

    console.log(`  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ${failing}${how}`);
  }
} finally {
  restoreAll();
  console.log('\n# restored');
}

if (anchorProblems.length > 0) {
  console.log(
    `\n⚠️ ${String(anchorProblems.length)} ANCHOR(S) DRIFTED — these mutants did not run:\n  ${anchorProblems.join('\n  ')}`,
  );
  process.exitCode = 1;
}

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
