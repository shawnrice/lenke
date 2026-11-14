/**
 * DOES THE UNWINDOWED EXPRESSION-SORT GATE HAVE TEETH? (item 1902)
 *
 * ⚠️ THE CHANGE IS ONE GATE, so the mutants are about which shapes it admits — and the one that
 * matters most is the mutant that admits a `SKIP` WITH NO `LIMIT`, because that is the case item
 * 1062's rules refuse for a stated correctness reason: with no cap the general path projects every
 * row and drops the skipped ones afterwards, so a faulting item raises, while ranking-then-
 * projecting would emit fewer rows than it projects and silently not raise.
 *
 * ⚠️ THE TEST SET CARRIES THREE PRE-EXISTING FILES BESIDE THE NEW ONE. `page-fold-fault.test.ts` is
 * the suite that caught item 1062's first cut admitting exactly that, and the two ordered-projection
 * files guard the arms this item did not touch — running the new file alone would credit this change
 * with coverage that predates it and would miss a mutant that breaks a neighbour.
 *
 *     bun sort-gate-mutants-1902.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { ns: `${ROOT}/packages/gql/src/executor/node-scan.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1902`;
const TESTS = [
  'src/unwindowed-expr-sort.test.ts',
  'src/page-fold-fault.test.ts',
  'src/deferred-sorted-projection.test.ts',
  'src/order-by-alias-expr.test.ts',
];

/** `[name, which, from, to, expectedOccurrences, occurrence?]` */
const MUTANTS = [
  [
    'a SKIP with no LIMIT is admitted — the refusal with a correctness reason',
    'ns',
    'const noWindow = skip === undefined && limit === undefined;',
    'const noWindow = limit === undefined;',
    1,
  ],
  [
    'every window is admitted, LIMIT 0 and a param page included',
    'ns',
    'const noWindow = skip === undefined && limit === undefined;',
    'const noWindow = true;',
    1,
  ],
  [
    'the no-window case carries a limit of 0 into the plan',
    'ns',
    "limit: typeof limit === 'number' ? limit : undefined,\n    },\n  });\n};\nexport const detectNodeProjection",
    "limit: typeof limit === 'number' ? limit : 0,\n    },\n  });\n};\nexport const detectNodeProjection",
    1,
  ],
  [
    'the no-window case carries a limit of 1 into the plan',
    'ns',
    "limit: typeof limit === 'number' ? limit : undefined,\n    },\n  });\n};\nexport const detectNodeProjection",
    "limit: typeof limit === 'number' ? limit : 1,\n    },\n  });\n};\nexport const detectNodeProjection",
    1,
  ],
  [
    'the skip default becomes 1 rather than 0',
    'ns',
    "      skip: typeof skip === 'number' ? skip : 0,\n      // `undefined` for the no-window case",
    "      skip: typeof skip === 'number' ? skip : 1,\n      // `undefined` for the no-window case",
    1,
  ],
  [
    'the arm is never taken unwindowed (the change reverted — ROUTE only)',
    'ns',
    'const noWindow = skip === undefined && limit === undefined;',
    'const noWindow = false;',
    1,
  ],
  [
    'a key that is not row-local to the scan variable is admitted',
    'ns',
    'if (nameRead !== nodeVar || outNames.has(nameRead)) {',
    'if (outNames.has(nameRead)) {',
    1,
  ],
  [
    'a SUBQUERY sort key is admitted',
    'ns',
    'if (!itemLocal(expr) || hasSubquery(expr)) {',
    'if (!itemLocal(expr)) {',
    1,
  ],
  [
    'the alias-to-expression rewrite is dropped',
    'ns',
    'const expr = named === undefined ? key : named.expr;',
    'const expr = key;',
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ PRE-EXISTING, AND REDUNDANT FOR EVERY SHAPE THIS ARM CAN SEE — not a gap this item opened.
   * `deferredSortKeys` is item 1062's, and `detectNodeProjection` admits a SINGLE node pattern, so
   * the only free variable a key can read IS `nodeVar`; the `outNames` half of the same condition
   * is what actually rejects anything. It is the identical situation `node-scan.ts` already
   * documents for `variable === nodeVar` ("REDUNDANT TODAY and kept deliberately — mutation says
   * so"), and item 475's rule applies: a surviving mutant on a guard means "redundant" as readily
   * as "untested", and the two have opposite fixes. Left in place as the thing that fails loudly
   * if the detector is ever widened to a second variable.
   */
  'a key that is not row-local to the scan variable is admitted',
]);

/*
 * ⚠️⚠️ AND ONE ENTRY WAS REMOVED FROM THIS SET BECAUSE THE HARNESS CONTRADICTED IT. Reverting the
 * change is ANSWER-EQUIVALENT — the old route returns the same rows, slower — so it was declared an
 * expected survivor on [[perf-gate-needs-its-own-test]] grounds. It is CAUGHT, by the ROUTE
 * assertions in `unwindowed-expr-sort.test.ts`, and the harness said so ("was expected to SURVIVE
 * and did not — update the entry"). That is the rule working in the direction nobody checks.
 */

/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/**
 * ⚠️ BOTH STREAMS, ALWAYS: `bun test` writes `N pass` to **stderr**, and item 767 read an empty
 * stdout and concluded the runner never ran a test.
 */
const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });

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

try {
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want, occurrence = 0] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    const parts = pristine.split(from);

    writeFileSync(
      SRCS[which],
      `${parts.slice(0, occurrence + 1).join(from)}${to}${parts.slice(occurrence + 1).join(from)}`,
    );

    const r = run();
    const result = /(\d+ pass, )?(\d+) fail/.exec(r.text);
    const ran = /\d+ pass/.test(r.text);

    if (!ran && r.code !== 124) {
      console.log(`  ⚠️ DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
      survivors.push(`${name} (no result line)`);
      continue;
    }

    const caught = r.code === 124 ? 'TIMEOUT (caught)' : r.code !== 0;
    const expected = EXPECTED_SURVIVORS.has(name);

    if (caught === false && !expected) {
      survivors.push(name);
    }

    if (caught !== false && expected) {
      survivors.push(`${name} (was expected to SURVIVE and did not — update the entry)`);
    }

    console.log(
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(56)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
