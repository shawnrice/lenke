/**
 * DOES the far-label CSR route have teeth? (item 1941)
 *
 * THE DANGEROUS MUTANT IS THE FLAG. `csrHopRoute` now ADMITS a broad non-vacuous far label and
 * returns `testFarLabel` to say the label still has to be applied per slot. A caller that ignores
 * it, or a route that reports `false` when the label does exclude somebody, emits rows for
 * OFF-LABEL far vertices — a wrong answer, not a slow one.
 *
 * And the mirror risk is a REGRESSION with no wrong answer: admitting a SELECTIVE label sends an
 * O(V) arm at a problem where bucket iteration is sub-linear (item 1688), which no test over rows
 * can see. That is why the threshold and `labelCoverage` are unit-tested as pure values.
 *
 * WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun farlabel-mutants-1941.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  csr: `${ROOT}/packages/gql/src/executor/csr-cache.ts`,
  hop: `${ROOT}/packages/gql/src/executor/hop-projection.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1941m`;
const CWD = `${ROOT}/packages/gql`;
const TESTS = [
  'src/hop-projection-csr.test.ts',
  'src/hop-projection.test.ts',
  'src/edge-driven-hop-walk.test.ts',
  'src/vacuous-label-elision.test.ts',
  'src/two-hop-count-csr.test.ts',
  'src/dedup-hop-far-driven.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    '\u26a0\u26a0 THE PER-SLOT TEST IS GONE, so off-label far vertices emit rows',
    'hop',
    '        if (testFarLabel && farLabel !== undefined && !matchesLabel(order[slot], farLabel)) {\n          continue;\n        }\n\n',
    '',
    1,
  ],
  [
    '\u26a0\ufe0f the flag is IGNORED at the call site (the test never runs)',
    'hop',
    'if (testFarLabel && farLabel !== undefined',
    'if (false && farLabel !== undefined',
    1,
  ],
  [
    '\u26a0\ufe0f testFarLabel always FALSE, so an admitted label is never applied',
    'csr',
    '    : { tables, testFarLabel: farLabel !== undefined && !vacuousLabel(graph, farLabel) };',
    '    : { tables, testFarLabel: false };',
    1,
  ],
  [
    'testFarLabel always TRUE, which tests a vacuous label for nothing',
    'csr',
    '    : { tables, testFarLabel: farLabel !== undefined && !vacuousLabel(graph, farLabel) };',
    '    : { tables, testFarLabel: true };',
    1,
  ],
  [
    '\u26a0\u26a0 A SELECTIVE far label is ADMITTED (an O(V) arm where the bucket is sub-linear)',
    'csr',
    '  if (farLabel !== undefined && !vacuousLabel(graph, farLabel) && !broadFarLabel) {\n    return undefined;\n  }',
    '',
    1,
  ],
  [
    'the coverage test uses the WRONG comparison, admitting only selective labels',
    'csr',
    '(labelCoverage(graph, farLabel) ?? 0) >= EDGE_DRIVEN_MIN_COVERAGE',
    '(labelCoverage(graph, farLabel) ?? 0) <= EDGE_DRIVEN_MIN_COVERAGE',
    1,
  ],
  [
    'an UNREADABLE coverage (a compound label) defaults to broad instead of declining',
    'csr',
    '(labelCoverage(graph, farLabel) ?? 0) >= EDGE_DRIVEN_MIN_COVERAGE',
    '(labelCoverage(graph, farLabel) ?? 1) >= EDGE_DRIVEN_MIN_COVERAGE',
    1,
  ],
  [
    'the route claims its own FIRST ask, paying the CSR build on a one-shot query',
    'csr',
    // eslint-disable-next-line no-template-curly-in-string -- this IS the source text being matched
    "  const tables = csrAskedBefore(graph, `hop:${out ? '<' : '>'}${typeName}`)\n    ? csrFor(graph, out, [typeName])\n    : undefined;",
    '  const tables = csrFor(graph, out, [typeName]);',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([]);

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
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

/** BOTH STREAMS CONCATENATED, THEN the exit code: `bun test` reports to STDERR (item 767). */
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
      console.log(`  DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-500)}`);
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
    `\n${String(anchorProblems.length)} ANCHOR(S) DRIFTED — these mutants did not run:\n  ${anchorProblems.join('\n  ')}`,
  );
  process.exitCode = 1;
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
