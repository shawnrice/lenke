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
    '  for (const v of drained) {\n    if (v == null) {\n      continue;\n    }\n\n    sawNonNull = true;\n    total += asNumber(v);',
    '  for (const v of drained) {\n    sawNonNull = true;\n    total += asNumber(v);',
    1,
  ],
  /*
   * ⚠️⚠️ THIS MUTANT WAS A NO-OP AS WRITTEN AND SURVIVED FOR THAT REASON (found at item 2408, the
   * first time the battery ran against live code). It replaced `count += 1` with
   * `count = count + 1 + 0` — the same arithmetic, so there was nothing for a test to catch, and
   * the ❌ SURVIVED line read as a coverage gap in the fold rather than a defect in the battery.
   * Item 1918 wrote all twelve and reported none of their verdicts, which is how it shipped.
   *
   * 🔑 THE INTENT WAS "`mean` DIVIDES BY EVERY VALUE, NULLS INCLUDED", and this is that: a null is
   * COUNTED but not added, so `sum` is untouched and only `mean` moves — which is what makes it a
   * sharp mutant rather than a blunt one.
   */
  [
    'mean divides by EVERY value, nulls included',
    'agg',
    '  for (const v of drained) {\n    if (v == null) {\n      continue;\n    }',
    '  for (const v of drained) {\n    if (v == null) {\n      count += 1;\n      continue;\n    }',
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
    '  for (const v of drained) {\n    if (v == null) {\n      continue;\n    }\n\n    sawNonNull = true;\n    total += asNumber(v);\n    count += 1;',
    '  for (const v of [...drained].reverse()) {\n    if (v == null) {\n      continue;\n    }\n\n    sawNonNull = true;\n    total += asNumber(v);\n    count += 1;',
    1,
  ],
  /*
   * ⚠️ THE DRAIN IS REVERTED — item 2408's second measurement, and the one I got wrong by
   * prediction: iterating the walk instead of draining it costs **1.58x on `sum` and 1.49x on
   * `mean`** and is otherwise ANSWER-IDENTICAL, since a drain yields the same elements in the same
   * order. So only `projected-numeric-fold.test.ts`'s walk-with-disagreeing-drain can see it.
   */
  [
    'the eager drain is reverted to lazy iteration',
    'agg',
    '  const drained = values.drain === undefined ? values : values.drain();',
    '  const drained = values;',
    1,
  ],
  // ---- the gate ----
  /*
   * ⚠️⚠️ THESE TWO ANCHORS CARRY `const { kind } = step;`, AND THE BARE `if` THEY USED TO USE WENT
   * AMBIGUOUS THE MOMENT THE CHANGE LANDED (item 2408). `fusableValuesAggregate` twenty lines above
   * tests the IDENTICAL four kinds; while the projected gate still read `min`/`max` only, the
   * four-kind line was unique to that OTHER function — taking the fusion made it match twice, and
   * an unqualified anchor would have mutated the scan-side gate instead of this one.
   *
   * Both were reported as ANCHOR DRIFT rather than run, which is item 1914's harness fix earning
   * itself, and [[ambiguous-anchor-strings]] is the standing lesson: count a string's occurrences
   * before anchoring on it. `= step` is the projected gate; `= next` is the scan-side one.
   */
  [
    'the gate admits any terminal kind',
    'agg',
    "  const { kind } = step;\n\n  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {\n    return undefined;\n  }",
    '  const { kind } = step;\n',
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
    'the sum/mean fusion is never taken (the pre-2408 route)',
    'agg',
    "  const { kind } = step;\n\n  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {",
    "  const { kind } = step;\n\n  if (kind !== 'min' && kind !== 'max') {",
    1,
  ],
];

/**
 * Names that MUST survive, each with its reason.
 *
 * ⚠️⚠️ **IT IS EMPTY, AND IT HELD ONE ENTRY UNTIL ITEM 2408 — the route-only mutant, which turned
 * out to be reachable by a test after all.** Item 1918 reasoned, correctly for the code it had,
 * that "declining the fusion sends `values(k).sum()` back through the generic residual, which
 * answers the SAME f64 in the SAME order … so by construction no answer test can see the route",
 * and left its gates to two instruments.
 *
 * 🔑 **WHAT CHANGED IS THE TEST, NOT THE ARGUMENT.** No ANSWER test can see the route — that part
 * stands. But [[perf-gate-needs-its-own-test]]'s actual remedy is to test the GATE as a pure
 * function, and item 1918's test file asserted the REFUSAL (`sum and mean are NOT folded`), so
 * narrowing the gate made that file greener rather than redder. `projected-aggregate.test.ts` now
 * asserts the ADMISSION — `fusableProjectedAggregate([{kind:'sum'}])` is `'sum'` — and the mutant
 * is caught by a unit test instead of only by the route screen.
 *
 * ⚠️ The two instruments are still the gates for the SPEED, which no unit test can be: the route
 * screen's `agg: hop values sum` row (`generic, 1 applyStep call [sum]` before, `SHORTCUT, 0`
 * after) and `numfold-ab-2408.sh` (1.81x / 1.95x, three controls flat, 3 order-alternated rounds).
 */
const EXPECTED_SURVIVORS = new Set([]);

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
 * ✅ **THE CHANGE THIS BATTERY TESTS SHIPPED AT ITEM 2408**, and this guard is kept rather than
 * deleted because it is also the "has the fold been reverted again?" check.
 *
 * ⚠️ IT RAN AS WRITTEN AND IT WAS NOT CLEAN, which is worth recording: item 1918 wrote all twelve
 * mutants, reported none of their verdicts, and reverted — so the first execution against live
 * code was item 2408's, and it found THREE defects in the battery itself. One mutant was a NO-OP
 * (`count += 1` -> `count = count + 1 + 0`, the same arithmetic) and survived for that reason,
 * reading as a coverage gap in the fold; two anchors went ambiguous the moment the fusion landed,
 * because the projected gate then matched `fusableValuesAggregate`'s identical four-kind test.
 * A battery that was written but never run is item 1918's own lesson about generative tests whose
 * teeth were never verified, applied to itself.
 */
if (!readFileSync(SRCS.agg, 'utf8').includes('foldProjectedNumeric')) {
  console.log(
    'the sum/mean fusion is NOT present in aggregation.ts — it shipped at item 2408, so its ' +
      'absence means it has been reverted. This battery has nothing to mutate. See ' +
      'docs/reviews/CLOSED.md item 2408.',
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
