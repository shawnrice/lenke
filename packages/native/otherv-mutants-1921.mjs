/**
 * DOES `other-v-normalize.test.ts` HAVE TEETH? (item 1921)
 *
 * ⚠️ THE SUBJECT IS A PLAN REWRITE, so the dangerous mutant is one that admits a shape where the
 * rewrite is NOT valid: `bothE(T).otherV()` must stay refused, because after `bothE` the arrival end
 * is not fixed by the step — which is the entire reason `otherV` exists. That mutant is a silent
 * wrong answer on every undirected edge.
 *
 * ⚠️ MOST OF THESE ARE CATCHABLE ONLY BECAUSE THE PASS IS EXPORTED. `normalizeDirectedOtherV` is
 * unit-tested on its OUTPUT PLAN — the step kinds and `readsPath` — so a mutant that stops rewriting
 * fails even though the ANSWER is unchanged. Without that, every route mutant here would be a
 * declared survivor. [[perf-gate-needs-its-own-test]], satisfied rather than invoked.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun otherv-mutants-1921.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { idx: `${ROOT}/packages/gremlin/src/executor/index.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1921m`;
const CWD = `${ROOT}/packages/gremlin`;
/** The neighbours keep item 1307's `inV` collapse and the path machinery honest. */
const TESTS = [
  'src/executor/other-v-normalize.test.ts',
  'src/executor/path-hop-values.test.ts',
  'src/executor/path-tracking.test.ts',
  'src/executor/edge-hop-fusion.test.ts',
  'src/executor/hop-values-csr.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    '⚠️ bothE is ADMITTED — a silent wrong end on every undirected edge',
    'idx',
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'inV', inE: 'outV' };",
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'inV', inE: 'outV', bothE: 'inV' };",
    1,
  ],
  [
    'outE maps to outV — the NEAR end',
    'idx',
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'inV', inE: 'outV' };",
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'outV', inE: 'outV' };",
    1,
  ],
  [
    'inE maps to inV — the NEAR end',
    'idx',
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'inV', inE: 'outV' };",
    "const EDGE_TO_FAR: Readonly<Record<string, 'inV' | 'outV'>> = { outE: 'inV', inE: 'inV' };",
    1,
  ],
  [
    'the preceding step is not checked at all, so ANY otherV becomes inV',
    'idx',
    '    const far = EDGE_TO_FAR[steps[i - 1].kind];\n\n    if (far === undefined) {\n      return step;\n    }',
    "    const far = 'inV';",
    1,
  ],
  [
    'the step BEFORE is read off by one',
    'idx',
    '    const far = EDGE_TO_FAR[steps[i - 1].kind];',
    '    const far = EDGE_TO_FAR[steps[i].kind];',
    1,
  ],
  [
    'readsPath is CARRIED OVER rather than recomputed (the whole point)',
    'idx',
    '    readsPath: steps2.some(stepReadsPath),',
    '    readsPath: plan.readsPath,',
    1,
  ],
  [
    'readsPath is hardcoded false, so a remaining path() is ignored',
    'idx',
    '    readsPath: steps2.some(stepReadsPath),',
    '    readsPath: false,',
    1,
  ],
  [
    'the i === 0 guard is dropped',
    'idx',
    "    if (step.kind !== 'otherV' || i === 0) {\n      return step;\n    }",
    "    if (step.kind !== 'otherV') {\n      return step;\n    }",
    1,
  ],
  [
    'the early-out claims there is never an otherV, so nothing is rewritten',
    'idx',
    "  if (!steps.some((s) => s.kind === 'otherV')) {\n    return plan;\n  }",
    '  return plan;',
    1,
  ],
  [
    'the `changed` short-circuit always rebuilds, losing the identity guarantee',
    'idx',
    '  if (!changed) {\n    return plan;\n  }',
    '',
    1,
  ],
  [
    'the pass is never CALLED (the pre-1921 route)',
    'idx',
    '  const planned = normalizeDirectedOtherV(plan);',
    '  const planned = plan;',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ ROUTE-ONLY: not calling the pass leaves the plan path-tracking, which answers the SAME rows
   * — that equality is the point of the item. Its gates are the workload screen's
   * `pathdep: outE.otherV` row (328.12 -> 48.71 ms, against its twin's 47.72) and the two new
   * `gremlin-spelling-probe.ts` groups, where the three spellings now sit within 1.17x.
   *
   * ⚠️ Note what is NOT here: every other mutant above. The pass is EXPORTED and tested on its
   * output plan, so a mutant that mis-rewrites or stops rewriting fails even with the call removed.
   */
  'the pass is never CALLED (the pre-1921 route)',
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
