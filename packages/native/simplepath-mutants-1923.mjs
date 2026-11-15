/**
 * DOES `simple-path-normalize.test.ts` HAVE TEETH? (item 1923)
 *
 * ⚠️ THE SUBJECT IS A PLAN REWRITE, so the dangerous mutant is one that admits a shape where the
 * rewrite is NOT valid. Two of those: DEPTH TWO (`simplePath` there needs all three elements
 * distinct, not just the ends) and `cyclicPath` (the complement, which needs `eq` — a shape item
 * 1912's rung declines). Either would be a silent wrong answer with a plausible row count.
 *
 * ⚠️ MOST OF THESE ARE CATCHABLE ONLY BECAUSE THE PASS IS EXPORTED. `normalizeDepth1SimplePath` is
 * unit-tested on its OUTPUT PLAN — the step kinds and `readsPath` — and on IDENTITY for every
 * refusal, so a mutant that mis-rewrites or stops rewriting fails even though the ANSWER is
 * unchanged. [[perf-gate-needs-its-own-test]], satisfied rather than invoked.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun simplepath-mutants-1923.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { idx: `${ROOT}/packages/gremlin/src/executor/index.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1923m`;
const CWD = `${ROOT}/packages/gremlin`;
/** The neighbours keep item 1912's tagged rung and the other two rewrites honest. */
const TESTS = [
  'src/executor/simple-path-normalize.test.ts',
  'src/executor/other-v-normalize.test.ts',
  'src/executor/tagged-hop-values.test.ts',
  'src/executor/path-hop-values.test.ts',
  'src/executor/path-tracking.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    '⚠️ DEPTH TWO is admitted, so a 3-element path is tested on its ENDS only',
    'idx',
    '  if (steps.length !== 3 && steps.length !== 4) {\n    return plan;\n  }',
    '  if (steps.length < 3) {\n    return plan;\n  }',
    1,
  ],
  [
    '⚠️ cyclicPath is admitted, so the COMPLEMENT is rewritten as the filter',
    'idx',
    "  if (tail.kind !== 'simplePath') {\n    return plan;\n  }",
    "  if (tail.kind !== 'simplePath' && tail.kind !== 'cyclicPath') {\n    return plan;\n  }",
    1,
  ],
  [
    'the predicate is eq, keeping ONLY the self-loops',
    'idx',
    "    { kind: 'where', pred: { op: 'neq', value: SIMPLE_PATH_TAG } },",
    "    { kind: 'where', pred: { op: 'eq', value: SIMPLE_PATH_TAG } },",
    1,
  ],
  [
    'the where compares against a DIFFERENT label than the as binds',
    'idx',
    "    { kind: 'where', pred: { op: 'neq', value: SIMPLE_PATH_TAG } },",
    "    { kind: 'where', pred: { op: 'neq', value: 'other' } },",
    1,
  ],
  [
    'the as_ step is dropped, so the where reads an unbound tag',
    'idx',
    "    { kind: 'as', label: SIMPLE_PATH_TAG },\n    hop,",
    '    hop,',
    1,
  ],
  [
    'a multi-type or untyped hop is admitted',
    'idx',
    "  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {\n    return plan;\n  }\n\n  if (tail.kind !== 'simplePath') {",
    "  if (hop.kind !== 'out' && hop.kind !== 'in') {\n    return plan;\n  }\n\n  if (tail.kind !== 'simplePath') {",
    1,
  ],
  [
    'any trailing step is passed through, not just a single-key values',
    'idx',
    "  if (proj !== undefined && (proj.kind !== 'values' || proj.keys.length !== 1)) {\n    return plan;\n  }",
    '',
    1,
  ],
  [
    'the trailing values is DROPPED from the rewrite',
    'idx',
    '  if (proj !== undefined) {\n    rewrittenSteps.push(proj);\n  }',
    '',
    1,
  ],
  [
    'readsPath is carried over rather than recomputed',
    'idx',
    '    readsPath: rewrittenSteps.some(stepReadsPath),',
    '    readsPath: plan.readsPath,',
    1,
  ],
  [
    'V(id, ...) is admitted, though it enumerates a given set',
    'idx',
    "  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {\n    return plan;\n  }\n\n  if ((hop.kind !== 'out'",
    "  if (source.kind !== 'V') {\n    return plan;\n  }\n\n  if ((hop.kind !== 'out'",
    1,
  ],
  [
    'the pass is never CALLED (the pre-1923 route)',
    'idx',
    '  const planned = normalizeDepth1SimplePath(normalizeDirectedOtherV(plan));',
    '  const planned = normalizeDirectedOtherV(plan);',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ ROUTE-ONLY: not calling the pass leaves the plan path-tracking, which answers the SAME rows
   * — that equality is the point of the item. Its gates are the workload screen's
   * `pathdep: simplePath` row (308.81 -> 37.81 ms) and `simplepath-parity-1923.mjs`.
   *
   * ⚠️ Note what is NOT here: every other mutant. The pass is EXPORTED and tested on its output plan
   * AND on identity for each refusal, so a mutant that mis-rewrites fails with the call removed.
   */
  'the pass is never CALLED (the pre-1923 route)',
]);

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

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

for (const [key, path] of Object.entries(SRCS)) {
  copyFileSync(path, `${PRISTINE}-${key}.ts`);
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(SRCS)) {
    copyFileSync(`${PRISTINE}-${key}.ts`, path);
  }
};

const survivors = [];
const anchorProblems = [];

try {
  const base = runTests();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-900)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want] of MUTANTS) {
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

    console.log(`  ${verdictLabel(caught, expected)}  ${name.padEnd(62)} ${failing}${how}`);
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
