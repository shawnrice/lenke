/**
 * DOES `edge-driven-hop-walk.test.ts` HAVE TEETH? (item 1940)
 *
 * ⚠️⚠️ TWO KINDS OF MUTANT HERE, AND THEY NEED DIFFERENT GUARDS:
 *
 *   - WRONG-ANSWER mutants (a label test dropped, the endpoints swapped) fail the answer tests.
 *   - ROUTE mutants (the coverage gate removed) change NO answer — they only choose a slower walk,
 *     which at 1% coverage is a 25x REGRESSION (item 1938). No test over rows can see that, so
 *     `labelCoverage` and `EDGE_DRIVEN_MIN_COVERAGE` are unit-tested as pure values
 *     ([[perf-gate-needs-its-own-test]]) and the mutants below aim at those.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun edgedriven-mutants-1940.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  hop: `${ROOT}/packages/gql/src/executor/hop-projection.ts`,
  lab: `${ROOT}/packages/gql/src/executor/labels.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1940m`;
const CWD = `${ROOT}/packages/gql`;
/** The neighbours are the other consumers of the same walk family and of `vacuousLabel`. */
const TESTS = [
  'src/edge-driven-hop-walk.test.ts',
  'src/hop-projection.test.ts',
  'src/vacuous-label-elision.test.ts',
  'src/far-driven-predicated.test.ts',
  'src/deferred-hop-order.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  // ———— wrong-answer mutants: the per-edge label tests ————
  [
    '\u26a0\ufe0f THE START LABEL IS NEVER TESTED, so off-label starts leak into the rows',
    'hop',
    '      if (startLabel !== undefined && !matchesLabel(start, startLabel)) {\n        continue;\n      }',
    '',
    1,
  ],
  [
    '\u26a0\ufe0f the START and FAR endpoints are SWAPPED',
    'hop',
    '      const far: Vertex = out ? edge.to : edge.from;\n      const start: Vertex = out ? edge.from : edge.to;',
    '      const far: Vertex = out ? edge.from : edge.to;\n      const start: Vertex = out ? edge.to : edge.from;',
    1,
  ],
  [
    'the start label is tested against the FAR vertex',
    'hop',
    '!matchesLabel(start, startLabel)',
    '!matchesLabel(far, startLabel)',
    1,
  ],
  [
    'the far label test is dropped in the edge-driven walk',
    'hop',
    '      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {\n        continue;\n      }\n\n      // \u26a0\ufe0f THE TEST THE COUNTING WALK CANNOT DO.',
    '      // \u26a0\ufe0f THE TEST THE COUNTING WALK CANNOT DO.',
    1,
  ],
  [
    'the walk binds the START vertex instead of the far one',
    'hop',
    '      binding.set(farVar, far);\n      rows.push(projectRow(proj, binding, params, graph));',
    '      binding.set(farVar, start);\n      rows.push(projectRow(proj, binding, params, graph));',
    1,
  ],
  // ———— route mutants: the ORDER BY escape and the coverage gate ————
  [
    '\u26a0\ufe0f an ORDER BY no longer forces the start-driven arm',
    'hop',
    '      if (startDrivenForOrder) {\n        return startDriven(graph, params);\n      }',
    '',
    1,
  ],
  [
    '\u26a0\u26a0 THE COVERAGE THRESHOLD IS 0, so a 1%-coverage label takes the O(|E|) arm (25x)',
    'lab',
    'export const EDGE_DRIVEN_MIN_COVERAGE = 0.4;',
    'export const EDGE_DRIVEN_MIN_COVERAGE = 0;',
    1,
  ],
  [
    'the threshold is 1, so the arm is unreachable and the cliff returns',
    'lab',
    'export const EDGE_DRIVEN_MIN_COVERAGE = 0.4;',
    'export const EDGE_DRIVEN_MIN_COVERAGE = 1.01;',
    1,
  ],
  [
    '\u26a0\ufe0f labelCoverage admits COMPOUND kinds, whose bucket size is not their coverage',
    'lab',
    "  if (expr?.kind !== 'label') {\n    return undefined;\n  }",
    '  if (expr === undefined) {\n    return undefined;\n  }',
    1,
  ],
  [
    'labelCoverage reports the bucket SIZE rather than the fraction',
    'lab',
    '  return total === 0 ? undefined : (graph.verticesByLabel.get(expr.name)?.size ?? 0) / total;',
    '  return total === 0 ? undefined : (graph.verticesByLabel.get(expr.name)?.size ?? 0);',
    1,
  ],
  [
    'an EMPTY graph reports coverage 0 instead of declining',
    'lab',
    '  return total === 0 ? undefined :',
    '  return total === 0 ? 0 :',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ SURVIVES, AND I DO NOT KNOW WHICH KIND OF SURVIVOR IT IS — which is the honest state and
   * item 475's rule verbatim: "a surviving mutant on a new guard means REDUNDANT as readily as
   * UNTESTED, and the two have opposite fixes."
   *
   * What the guard is FOR is documented and real: `deferredHopOrder` returns `startDriven: true`
   * because "the far-driven walk REORDERS rows and a stable sort leaves ties on ARRIVAL ORDER,
   * which is observable between the engines (item 605)". So the early return is how that intent
   * takes effect, and the edge-driven arm arrives in edge-bucket order.
   *
   * What I could NOT do is construct a query where removing it changes an answer. Three attempts:
   *   - a plain `ORDER BY x` — does not set `startDrivenForOrder` at all;
   *   - a windowed `ORDER BY x LIMIT 5` with TIES and the insertion index projected — same;
   *   - a faulting projection under a window (`b.n / b.id2 ... LIMIT 3`) — ⚠️ this THREW, and I
   *     briefly took that as the mutant biting. It throws on the PRISTINE engine too (the stack
   *     points at a different walk), so it was my expectation standing in for a control. No
   *     control, no finding — the same error class as the frame-attribution trap.
   *
   * The guard STAYS: it is cheap, it encodes a stated cross-engine contract, and the direction of
   * doubt is safety. But it is recorded here as untested rather than dressed up as covered, so the
   * next reader knows a shape that exercises it has not been found.
   */
  '⚠️ an ORDER BY no longer forces the start-driven arm',
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

    console.log(`  ${verdictLabel(caught, expected)}  ${name.padEnd(72)} ${failing}${how}`);
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
