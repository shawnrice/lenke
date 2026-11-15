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
    '⚠️ THE GUARD NEVER APPLIES (guardedBound is always empty)',
    'rw',
    '  const guardedBound = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedBound = [];',
    1,
  ],
  [
    '⚠️ EVERY binding is guarded, so a CHEAP one can no longer fold read-zero or read-twice',
    'rw',
    '  const guardedBound = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedBound = [...bound].map(([n]) => n);',
    1,
  ],
  [
    'the filter polarity is inverted, so only CHEAP bindings are guarded',
    'rw',
    '  const guardedBound = [...bound].filter(([, e]) => !cheapPureExpr(e)).map(([n]) => n);',
    '  const guardedBound = [...bound].filter(([, e]) => cheapPureExpr(e)).map(([n]) => n);',
    1,
  ],
  // ———— the OCCURRENCE counter (the hole item 1926 closed) ————
  [
    '⚠️ THE PRE-1926 COUNTER: guarded NAMES, not OCCURRENCES — power(a, a) scores 1 and DOUBLES',
    'rw',
    "    const reads = (e: Expr): number => {\n      if (guarded(e)) {\n        return 1;\n      }\n\n      return e.kind === 'func' ? e.args.filter(guarded).length : 0;\n    };",
    '    const reads = (e: Expr): number => {\n      const free = freePredicateVars(e);\n\n      return guardedBound.filter((name) => free.has(name)).length;\n    };',
    1,
  ],
  [
    "⚠️ a function's arguments are counted as ONE however many are the bound name",
    'rw',
    "      return e.kind === 'func' ? e.args.filter(guarded).length : 0;",
    "      return e.kind === 'func' && e.args.some(guarded) ? 1 : 0;",
    1,
  ],
  [
    'the function-argument arm counts NOTHING, so a folded call is never admitted',
    'rw',
    "      return e.kind === 'func' ? e.args.filter(guarded).length : 0;",
    '      return 0;',
    1,
  ],
  [
    '⚠️ `guarded` ignores WHICH name, so a cheap binding read twice counts as guarded reads',
    'rw',
    "    const guarded = (e: Expr): boolean => e.kind === 'var' && guardedBound.includes(e.name);",
    "    const guarded = (e: Expr): boolean => e.kind === 'var';",
    1,
  ],
  // ———— the threshold and its two sides ————
  [
    '⚠️ READ ZERO TIMES is admitted, so the binding evaluation (and its faults) disappear',
    'rw',
    '    if (total !== 1) {\n      return clauses;\n    }',
    '    if (total > 1) {\n      return clauses;\n    }',
    1,
  ],
  [
    '⚠️ READ TWICE is admitted, so the work doubles',
    'rw',
    '    if (total !== 1) {\n      return clauses;\n    }',
    '    if (total < 1) {\n      return clauses;\n    }',
    1,
  ],
  [
    '⚠️ ORDER BY reads are not counted, so projection-plus-ORDER-BY folds twice',
    'rw',
    '      proj.items.reduce((acc, it) => acc + reads(it.expr), 0) +\n      (proj.orderBy ?? []).reduce((acc, o) => acc + reads(o.expr), 0);',
    '      proj.items.reduce((acc, it) => acc + reads(it.expr), 0);',
    1,
  ],
  [
    'projection reads are not counted, so only ORDER BY decides',
    'rw',
    '      proj.items.reduce((acc, it) => acc + reads(it.expr), 0) +\n      (proj.orderBy ?? []).reduce((acc, o) => acc + reads(o.expr), 0);',
    '      (proj.orderBy ?? []).reduce((acc, o) => acc + reads(o.expr), 0);',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([]);

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
