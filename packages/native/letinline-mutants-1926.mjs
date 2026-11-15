/**
 * DOES `let-inline-any-expr.test.ts` HAVE TEETH? (item 1926)
 *
 * ⚠️ THE SUBJECT IS A ROUTE CHOICE AND THEREFORE ANSWER-EQUIVALENT: folding
 * `LET a = n.n + 1 RETURN a` into `RETURN (n.n + 1)` changes no row, so every mutant that merely
 * stops the fold survives every differential test in the package. The tests assert
 * `compileLinear(...).clauses.map(c => c.kind)` for exactly that reason
 * ([[perf-gate-needs-its-own-test]]), which is what gives the mutants below something to fail.
 *
 * 🔑 THE DANGEROUS MUTANTS ARE THE ONES THAT WIDEN ADMISSION, not the ones that narrow it. The
 * widening at item 1926 rests on ONE proof — the projection reads the bound name EXACTLY ONCE, so
 * the expression is evaluated once per row either way — and anything that breaks the counting turns
 * a free fold into DUPLICATED WORK (or, read zero times, into a DROPPED evaluation and with it any
 * fault it would raise). Four mutants attack the counter directly; `power(a, a)` is the input that
 * discriminates, and it is in the battery because the pre-1926 counter got it wrong.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907); test paths listed from the directory (item 1915).
 *
 *     bun letinline-mutants-1926.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  core: `${ROOT}/packages/gql/src/executor/core.ts`,
  rw: `${ROOT}/packages/gql/src/executor/rewrites.ts`,
  ea: `${ROOT}/packages/gql/src/executor/expr-analysis.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1926m`;
const CWD = `${ROOT}/packages/gql`;
/**
 * The neighbours are the OTHER consumers of the same two functions: `distinct-via-let` is the
 * shortcut that reads a folded `[match, return]`, and `call-inline-rewrite` is the composition
 * item 1662 established (`inlineCorrelatedCall` emits a `LET` this pass then folds).
 */
const TESTS = [
  'src/let-inline-any-expr.test.ts',
  'src/distinct-via-let.test.ts',
  'src/call-inline-rewrite.test.ts',
  'src/distinct-count-fold.test.ts',
  'src/column-order.test.ts',
];

/*
 * ⚠️ SIX OF ITEM 1926'S ENTRIES WERE REMOVED AT ITEM 1927, DELIBERATELY, because the MECHANISM
 * they attacked no longer exists — not because they stopped failing. The one-level `subst` and its
 * separate `reads` counter are gone: the count now comes from `substituteVarsDeep` itself, so there
 * is no name-vs-occurrence distinction to get wrong, no function-argument arm counting separately,
 * and no `guarded` helper to mis-scope. Their coverage is carried by the `count`/arm mutants below.
 *
 * 🔑 The two `total !== 1` threshold entries were replaced by their `at depth` twins, which attack
 * the same line in its new form. A dead mutant silently loses the coverage an earlier item built,
 * so each removal is accounted for here rather than left to a reader to notice.
 */
/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  // ———— the admission gate in `boundExprs` ————
  [
    'the pre-1926 NARROW gate is restored (cheap only), so arithmetic never folds',
    'core',
    '    return new Map([[name, expr]]);',
    '    return cheapPureExpr(expr) ? new Map([[name, expr]]) : null;',
    1,
  ],
  [
    '⚠️ TWO LET items are admitted, so a later item reading an earlier one is rewritten unbound',
    'core',
    '    if (c.items.length !== 1) {\n      return null;\n    }',
    '    if (c.items.length < 1) {\n      return null;\n    }',
    1,
  ],
  // ———— the once-read guard, which is what makes the widening sound ————
  [
    '⚠️ THE GUARD NEVER APPLIES (guardedNames is always empty)',
    'rw',
    '  const guardedNames = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedNames = [];',
    1,
  ],
  [
    '⚠️ EVERY binding is guarded, so a CHEAP one can no longer fold read-zero or read-twice',
    'rw',
    '  const guardedNames = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedNames = [...bound].map(([n]) => n);',
    1,
  ],
  [
    'the filter polarity is inverted, so only CHEAP bindings are guarded',
    'rw',
    '  const guardedNames = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedNames = [...bound].filter(([, e]) => cheapPureExpr(e)).map(([n]) => n);',
    1,
  ],
  // ———— the OCCURRENCE counter (the hole item 1926 closed) ————
  // ———— the threshold and its two sides ————

  // ———— item 1927: the DEEP substitution, and the post-check that makes it safe ————
  [
    '⚠️⚠️ THE POST-CHECK IS GONE, so a name left inside EXISTS/COUNT/letIn folds anyway',
    'rw',
    '    const free = freePredicateVars(out);\n\n    if ([...bound.keys()].some((n) => free.has(n))) {\n      return null;\n    }\n',
    '',
    1,
  ],
  [
    '⚠️ the post-check tests the WRONG set, so any surviving mention passes',
    'rw',
    '    if ([...bound.keys()].some((n) => free.has(n))) {',
    '    if (free.size > 1000) {',
    1,
  ],
  [
    '⚠️ EXISTS is DESCENDED INTO, so a substitution can CAPTURE a pattern variable',
    'ea',
    "      case 'in':\n        return { ...e, expr: go(e.expr), list: go(e.list) };",
    "      case 'exists':\n        return { ...e, where: e.where === undefined ? undefined : go(e.where) };\n      case 'in':\n        return { ...e, expr: go(e.expr), list: go(e.list) };",
    1,
  ],
  [
    '⚠️ letIn is DESCENDED INTO, so a SHADOWED name is substituted',
    'ea',
    "      case 'in':\n        return { ...e, expr: go(e.expr), list: go(e.list) };",
    "      case 'letIn':\n        return { ...e, body: go(e.body) };\n      case 'in':\n        return { ...e, expr: go(e.expr), list: go(e.list) };",
    1,
  ],
  [
    'the replacement COUNT is never incremented, so every guarded fold declines',
    'ea',
    '        count += 1;',
    '        count += 0;',
    1,
  ],
  [
    'the var arm does not substitute at all',
    'ea',
    '        count += 1;\n\n        return sub;',
    '        count += 1;\n\n        return e;',
    1,
  ],
  [
    'the arith arm is dropped, so a name inside arithmetic is stranded again',
    'ea',
    "      case 'arith':\n        return {\n          ...e,\n          head: go(e.head),\n          tail: e.tail.map(([op, operand]) => [op, go(operand)] as const),\n        };",
    '',
    1,
  ],
  ['the CASE arm is dropped', 'ea', "      case 'case':\n        return goCase(e);", '', 1],
  [
    "the func arm is dropped, so item 565's own shape regresses",
    'ea',
    "      case 'func':\n        return { ...e, args: all(e.args) };",
    '',
    1,
  ],
  [
    '⚠️ READ ZERO TIMES is admitted at depth',
    'rw',
    '  if (guardedNames.length > 0 && guardedReads !== 1) {',
    '  if (guardedNames.length > 0 && guardedReads > 1) {',
    1,
  ],
  [
    '⚠️ READ TWICE is admitted at depth, so the work doubles',
    'rw',
    '  if (guardedNames.length > 0 && guardedReads !== 1) {',
    '  if (guardedNames.length > 0 && guardedReads < 1) {',
    1,
  ],
  [
    'the guard never applies, whatever the binding',
    'rw',
    '  if (guardedNames.length > 0 && guardedReads !== 1) {',
    '  if (false) {',
    1,
  ],
  [
    '⚠️ ORDER BY is not substituted, so its reads go uncounted AND unfolded',
    'rw',
    '    const e = substituted(o.expr);',
    '    const e = { expr: o.expr, count: 0 };',
    1,
  ],
  [
    'the alias is never pinned, so an un-aliased RETURN a renames its column',
    'rw',
    '      e.count === 0\n        ? it',
    '      true\n        ? it',
    1,
  ],
  // ———— item 1928: the FIXPOINT loop ————
  [
    '⚠️ THE LOOP IS GONE (the pre-1928 single pass), so a chain keeps a standing LET',
    'rw',
    '      inlineTrailingLet(\n',
    '      inlineTrailingLetOnce(\n',
    1,
  ],
  [
    '⚠️ the bound is ONE, so only the first fold happens',
    'rw',
    '  let rounds = clauses.length;',
    '  let rounds = 1;',
    1,
  ],
  [
    '⚠️ the cursor never advances, so every round re-folds the SAME input',
    'rw',
    '    cur = next;\n  }',
    '  }',
    1,
  ],
  [
    'the fixpoint test is INVERTED, so the loop exits on the first SUCCESSFUL fold',
    'rw',
    '    if (next.length === cur.length) {\n      return cur;\n    }',
    '    if (next.length !== cur.length) {\n      return cur;\n    }',
    1,
  ],
  [
    '⚠️ the loop returns the UNFOLDED input whatever it did',
    'rw',
    '  return cur;\n};',
    '  return clauses;\n};',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ EQUIVALENT MUTANT, not a coverage gap (item 1928). The statement after the fixpoint loop is
   * UNREACHABLE under the pass's contract: each successful fold shortens the clause list by exactly
   * one and the shortest result is `[match, return]`, so at most `length - 2` folds happen and
   * iteration `length - 1` detects the fixpoint and returns from inside the loop. The loop cannot
   * run out, so `return cur` and `return clauses` differ only in a state no input reaches — and both
   * are CORRECT even there, since every fold already applied is answer-preserving.
   *
   * 🔑 It is tested-for anyway because the BOUND is deliberate belt-and-braces against a future edit
   * that rewrites without shortening, and an entry here is how that intent survives the next reader.
   */
  '⚠️ the loop returns the UNFOLDED input whatever it did',
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
