/**
 * DOES THE MIN/MAX DRAIN HAVE TEETH? (item 1919)
 *
 * THE QUESTION THIS BATTERY EXISTS TO ANSWER is whether the drain is a ROUTE-ONLY change.
 * Taking a walk's `drain` yields the same elements in the same order, so no answer test can see it
 * — and item 1909 hit exactly that, declared "the drain is never used" an expected survivor, and
 * then REMOVED the entry because a unit test on the helper made the choice observable. This item
 * copied that: `projected-aggregate.test.ts` now drives `foldProjectedMinMax` with a walk whose
 * `drain` and iterator DISAGREE. If that works, mutant #1 below is CAUGHT and this item has no
 * route-only survivor at all.
 *
 * WRITTEN DIRECTLY, not templated from the previous item's battery (item 1907's lesson), and
 * every test path was listed from the directory rather than recalled (item 1915 found a
 * non-existent path in its own first draft).
 *
 * UNDER BOTH A TIMEOUT AND A CGROUP CAP; 124 and 137 ARE the mutant being caught. The net was
 * proved at item 1915 — a 2G cap kills an allocator bomb by signal in 7.3 s where 16G lets bun exit
 * 1 after 49.1 s, so the cap and not the runtime's own ceiling is doing it.
 *
 *     bun minmax-drain-mutants-1919.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { agg: `${ROOT}/packages/gremlin/src/executor/aggregation.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1919m`;
const CWD = `${ROOT}/packages/gremlin`;
/** Listed from the directory. The fold's neighbours keep the `fold()` twin honest. */
const TESTS = [
  'src/executor/projected-aggregate.test.ts',
  'src/executor/projected-fold.test.ts',
  'src/executor/fused-values-aggregate.test.ts',
  'src/executor/hop-values-residual.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    'the drain is never used (the pre-1919 route)',
    'agg',
    '  const src = values.drain === undefined ? values : values.drain();',
    '  const src = values;',
    1,
  ],
  [
    'the drain is used UNCONDITIONALLY, so an array input throws',
    'agg',
    '  const src = values.drain === undefined ? values : values.drain();',
    '  const src = values.drain();',
    1,
  ],
  [
    'min and max are inverted',
    'agg',
    "    if (kind === 'min' ? c < 0 : c > 0) {\n      best = v;\n    }\n  }\n\n  return [seen ? best : null];",
    "    if (kind === 'min' ? c > 0 : c < 0) {\n      best = v;\n    }\n  }\n\n  return [seen ? best : null];",
    1,
  ],
  [
    'a null is folded instead of skipped',
    'agg',
    '  for (const v of src) {\n    if (v == null) {\n      continue;\n    }',
    '  for (const v of src) {',
    1,
  ],
  [
    'an all-null input answers NOTHING instead of [null]',
    'agg',
    '  return [seen ? best : null];',
    '  return seen ? [best] : [];',
    1,
  ],
  [
    'the first element is never seeded, so everything compares against undefined',
    'agg',
    '    if (!seen) {\n      best = v;\n      seen = true;\n      continue;\n    }',
    '    if (!seen) {\n      seen = true;\n      continue;\n    }',
    1,
  ],
];

/** Names that MUST survive, each with its reason. Empty is the goal here — see the header. */
const EXPECTED_SURVIVORS = new Set([]);

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
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
    `\n${String(anchorProblems.length)} ANCHOR(S) DRIFTED — these mutants did not run:\n  ${anchorProblems.join('\n  ')}`,
  );
  process.exitCode = 1;
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
