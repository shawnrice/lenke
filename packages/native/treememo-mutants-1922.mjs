/**
 * DOES `tree-key-memo.test.ts` HAVE TEETH? (item 1922)
 *
 * ⚠️ THE DANGEROUS MUTANT IS THE GATE, NOT THE MEMO. Turning the memo ON for a plan that mutates is
 * a silent wrong answer: the stream is pulled lazily, so a mutation step upstream of `tree()` runs
 * interleaved with the tree insertion, and an element keyed on both sides of its own mutation gets
 * TWO legitimately different keys. A memo answers from the stale side. That is the mutant to catch.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun treememo-mutants-1922.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  proj: `${ROOT}/packages/gremlin/src/executor/projection.ts`,
  ast: `${ROOT}/packages/gremlin/src/ast.ts`,
  idx: `${ROOT}/packages/gremlin/src/executor/index.ts`,
  rt: `${ROOT}/packages/gremlin/src/executor/runtime.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1922m`;
const CWD = `${ROOT}/packages/gremlin`;
const TESTS = [
  'src/executor/tree-key-memo.test.ts',
  'src/executor/path-hop-values.test.ts',
  'src/executor/other-v-normalize.test.ts',
  'src/executor/path-tracking.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  // ---- the gate, which is the correctness half ----
  [
    '⚠️ the memo is ON unconditionally, ignoring mutations',
    'proj',
    '  const memo = ctx.keysStable === true ? new Map<unknown, string>() : undefined;',
    '  const memo = new Map<unknown, string>();',
    1,
  ],
  [
    '⚠️ keysStable is passed as TRUE for every plan',
    'idx',
    '  const ctx = newContext(planReadsPath(planned), !planMutates(planned));',
    '  const ctx = newContext(planReadsPath(planned), true);',
    1,
  ],
  [
    'the gate is inverted, so only MUTATING plans memoize',
    'idx',
    '  const ctx = newContext(planReadsPath(planned), !planMutates(planned));',
    '  const ctx = newContext(planReadsPath(planned), planMutates(planned));',
    1,
  ],
  [
    'planMutates misses `property`',
    'ast',
    "export const MUTATION_KINDS: ReadonlySet<string> = new Set(['addV', 'addE', 'property', 'drop']);",
    "export const MUTATION_KINDS: ReadonlySet<string> = new Set(['addV', 'addE', 'drop']);",
    1,
  ],
  [
    'planMutates does not recurse into sub-plans',
    'ast',
    '      if (sub !== undefined && planMutates(sub)) {\n        return true;\n      }',
    '',
    1,
  ],
  [
    'planMutates ignores the `plans` ARRAY (union/or/and)',
    'ast',
    '    if (list !== undefined && list.some(planMutates)) {\n      return true;\n    }',
    '',
    1,
  ],
  [
    'keysStable DEFAULTS to true, so a bare context memoizes',
    'rt',
    'export const newContext = (tracksPath = true, keysStable = false): RunContext => ({',
    'export const newContext = (tracksPath = true, keysStable = true): RunContext => ({',
    1,
  ],
  // ---- the memo itself ----
  [
    'the memo returns a CONSTANT key, collapsing the whole tree',
    'proj',
    '  const key = treeKey(node);\n\n  memo.set(node, key);\n\n  return key;',
    "  const key = 'K';\n\n  memo.set(node, key);\n\n  return key;",
    1,
  ],
  [
    'the memo is never populated, so it only costs',
    'proj',
    '  memo.set(node, key);\n\n  return key;',
    '  return key;',
    1,
  ],
  [
    'a SCALAR path position is memoized too, by identity',
    'proj',
    '  if (memo === undefined || !(isVertex(node) || isEdge(node))) {\n    return treeKey(node);\n  }',
    '  if (memo === undefined) {\n    return treeKey(node);\n  }',
    1,
  ],
  [
    'the memo keys by ID rather than identity',
    'proj',
    '  const hit = memo.get(node);',
    '  const hit = memo.get((node as { id?: unknown }).id);',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ ROUTE-ONLY IN THE *ANSWER* SENSE: never populating the memo answers identically, just at the
   * pre-1922 cost plus a pointless `Map` lookup per element. Its gate is `tree-prof-1922.mjs`
   * (1013.61 -> 547.01 ms with `tree().by(k)` flat at 267.90 as the control).
   */
  'the memo is never populated, so it only costs',
  /*
   * ⚠️ ALSO ANSWER-EQUIVALENT: memoizing a scalar is correct, merely wasteful — a `Map` entry per
   * distinct scalar where `String(node)` is one operation. Declined on cost, so no answer test can
   * see it. The note in `memoizedTreeKey` records the reasoning.
   */
  'a SCALAR path position is memoized too, by identity',
  /*
   * ⚠️ ANSWER-EQUIVALENT WITHIN CONTRACT, and the reason is worth stating because it looks like a
   * real bug. Keying the memo by `node.id` instead of by the element itself would collide only if
   * two DIFFERENT elements in one tree build shared an id — i.e. a vertex and an edge, since a path
   * can hold both (`outE(T).inV().path()` is `[v, edge, v]`). A vertex and an edge sharing an id is
   * recorded as OUT OF CONTRACT and WON'T-FIX ([[cross-engine-divergences-open]]), so no in-contract
   * graph can discriminate the two keyings.
   *
   * Identity-keying is kept anyway: it cannot collide across the two id spaces at all, where
   * id-keying is correct only because of a contract clause elsewhere. A guard whose correctness
   * depends on a document rather than on the code is the weaker of the two.
   */
  'the memo keys by ID rather than identity',
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
