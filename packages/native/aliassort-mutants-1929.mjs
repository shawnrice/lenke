/**
 * DOES `alias-sort-key-normalize.test.ts` HAVE TEETH? (item 1929)
 *
 * ⚠️ THE SUBJECT IS AN ABSENCE OF A RUNG. `ORDER BY x + 1` reached NO fast path at all while
 * `ORDER BY n.n + 1` reached `nodeProjection` — the same question, 3.2-3.4x apart on node and hop.
 * The rewrite is ANSWER-EQUIVALENT, so the tests assert the ROUTE as well as the rows, and that is
 * what gives these mutants something to fail ([[perf-gate-needs-its-own-test]]).
 *
 * 🔑 THE DANGEROUS MUTANTS WIDEN WHAT IS SUBSTITUTED. Two guards carry the whole soundness
 * argument and each has its own negation below:
 *
 *   - `cheapPureExpr`, because substituting DUPLICATES the aliased expression's evaluation (once
 *     for the column, once for the key). A property read is free and cannot fault; a subquery is
 *     neither.
 *   - the COLLIDING-OUTPUT-NAME refusal, because in the sort scope output columns are OVERLAID on
 *     the binding — with `n.k AS n`, a substituted `n.n` would read a property of the COLUMN.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun aliassort-mutants-1929.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { rw: `${ROOT}/packages/gql/src/executor/rewrites.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1929m`;
const CWD = `${ROOT}/packages/gql`;
/** The neighbours are the other consumers of the sort-key arms this pass feeds. */
const TESTS = [
  'src/alias-sort-key-normalize.test.ts',
  'src/deferred-sorted-projection.test.ts',
  'src/column-order.test.ts',
  'src/let-inline-any-expr.test.ts',
  'src/distinct-via-let.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    '⚠️ THE PASS IS NEVER CALLED (the pre-1929 route), so the alias spelling reaches no rung',
    'rw',
    '      normalizeAliasSortKeys(\n        inlineTrailingLet(',
    '        inlineTrailingLet(',
    1,
  ],
  [
    '⚠️ A NON-CHEAP ALIAS IS SUBSTITUTED, duplicating a subquery evaluation per row',
    'rw',
    '    if (it.alias !== undefined && cheapPureExpr(it.expr)) {',
    '    if (it.alias !== undefined) {',
    1,
  ],
  [
    '⚠⚠ THE OVERLAY CHECK IS GONE, so a colliding output name is rewritten anyway',
    'rw',
    '  for (const [, e] of bound) {\n    for (const nameRead of freePredicateVars(e)) {\n      if (outNames.has(nameRead)) {\n        return clauses;\n      }\n    }\n  }',
    '',
    1,
  ],
  [
    'the overlay check tests the WRONG set, so it never fires',
    'rw',
    '      if (outNames.has(nameRead)) {\n        return clauses;\n      }',
    "      if (outNames.has('~never')) {\n        return clauses;\n      }",
    1,
  ],
  [
    '⚠️ A BARE ALIAS KEY IS REWRITTEN TOO, taking the query OFF the faster column-sort arm',
    'rw',
    "    if (k.expr.kind === 'var') {\n      return k;\n    }",
    '',
    1,
  ],
  [
    'the alias map is keyed on a MANGLED name, so no key ever matches',
    'rw',
    '      bound.set(it.alias, it.expr);',
    "      bound.set('~never', it.expr);",
    1,
  ],
  [
    'the substitution result is discarded, so nothing is rewritten',
    'rw',
    '    changed = true;\n\n    return { ...k, expr };',
    '    changed = true;\n\n    return k;',
    1,
  ],
  [
    'ORDER BY is replaced by the rewrite of a DIFFERENT clause field',
    'rw',
    '{ ...last, projection: { ...proj, orderBy: rewritten } }',
    '{ ...last, projection: { ...proj, orderBy: sorts } }',
    1,
  ],
  [
    'the pass fires on a STAR projection, whose columns it cannot enumerate',
    'rw',
    '  if (proj.star || sorts === undefined || sorts.length === 0) {',
    '  if (sorts === undefined || sorts.length === 0) {',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ EQUIVALENT MUTANT, documented in the pass itself (item 1929). A STAR projection has no
   * `items`, so `bound` comes out empty and the `bound.size === 0` check returns before anything is
   * rewritten — the `proj.star` test cannot change an outcome today. It stays as the statement of
   * intent (a star's columns are not enumerable here), which is item 475's rule: a surviving mutant
   * on a guard means "redundant" as readily as "untested", and the two have opposite fixes. This
   * one is redundant, and both the code and this entry say so.
   *
   * 🔑 Four other guards survived the FIRST run and are caught now: three were genuinely subsumed
   * or unreachable and were REMOVED or simplified away, and one was my test being vacuous
   * (`expect(rows(t)).toEqual(rows(t))`). Only this one is kept-and-redundant.
   */
  'the pass fires on a STAR projection, whose columns it cannot enumerate',
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
