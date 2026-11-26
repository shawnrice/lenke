/**
 * DOES `hop-projection-csr.test.ts` HAVE TEETH? (item 1895)
 *
 * TWO OF THESE MUTANTS ARE ROUTE-ONLY AND ANSWER-EQUIVALENT, which is why they are here at all:
 * admitting a SELECTIVE far label, and reading vacuity from the AST rather than the graph, both
 * return the right rows by the wrong route. The second one is not hypothetical — it is the bug the
 * first cut of this arm shipped, and it measured a flat null.
 *
 *     bun hop-csr-arm-mutants-1895.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  hop: `${ROOT}/packages/gql/src/executor/hop-projection.ts`,
  csr: `${ROOT}/packages/gql/src/executor/csr-cache.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1895`;
// BOTH test files, because the two halves catch different mutants: the answer file catches a
// missing slice, the ROUTE file catches a rung that starts claiming shapes it must leave alone —
// and a route change is answer-equivalent, which is `perf-gate-needs-its-own-test` exactly.
const TESTS = ['src/hop-projection-csr.test.ts'];

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  [
    // IN `csr-cache.ts` SINCE THE ROUTE WAS EXTRACTED — the arm no longer calls `csrFor` itself.
    'the route reads the WRONG direction',
    'csr',
    '    ? csrFor(graph, out, [typeName])',
    '    ? csrFor(graph, !out, [typeName])',
    1,
  ],
  [
    'the degree is off by one (one extra row per far vertex)',
    'hop',
    'let n = off[slot + 1] - off[slot];',
    'let n = off[slot + 1] - off[slot] + 1;',
    1,
  ],
  [
    'the clone loop emits one row too few',
    'hop',
    `        binding.set(farVar, order[slot]);

        const template = projectRow(proj, binding, params, graph);

        rows.push(template);

        for (n -= 1; n > 0; n -= 1) {
          rows.push({ ...template });
        }`,
    `        binding.set(farVar, order[slot]);

        const template = projectRow(proj, binding, params, graph);

        rows.push(template);

        for (n -= 2; n > 0; n -= 1) {
          rows.push({ ...template });
        }`,
    1,
  ],
  [
    'the far vertex bound is the SLOT INDEX, not the vertex',
    'hop',
    'binding.set(farVar, order[slot]);',
    'binding.set(farVar, order[0]);',
    1,
  ],
  [
    'the route admits a SELECTIVE far label (the arm would scan every slot)',
    'csr',
    'if (farLabel !== undefined && !vacuousLabel(graph, farLabel)) {',
    'if (false) {',
    1,
  ],
  [
    'the route reads vacuity from the AST instead of the graph (declines everything labelled)',
    'csr',
    'if (farLabel !== undefined && !vacuousLabel(graph, farLabel)) {',
    'if (farLabel !== undefined) {',
    1,
  ],
  [
    'the route claims its own FIRST ask',
    'csr',
    `  return csrAskedBefore(graph, \`hop:\${out ? '<' : '>'}\${typeName}\`)
    ? csrFor(graph, out, [typeName])
    : undefined;`,
    '  return csrFor(graph, out, [typeName]);',
    1,
  ],
];

/** Names that MUST survive, each with its reason stated at the entry above. */
const EXPECTED_SURVIVORS = new Set();

/**
 * BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return 'caught   ';
  }

  return expected ? '➖ survived (expected)' : 'SURVIVED';
};

const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: `${ROOT}/packages/gql`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

// Each of the three sources gets its own pristine copy under `target/` (gitignored, and it survives
// the reboot a runaway mutant may force — CLAUDE.md's rule, learned when `/tmp` was wiped).
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
  // The BASELINE must pass, or every mutant "fails" for the wrong reason.
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want, occurrence = 0] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop — an interrupted run must
    // not leave a mutant in the tree for `git diff` to be the only thing standing in its way.
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
      console.log(`  DID-NOT-RUN  ${name}  (exit ${String(r.code)})\n${r.text.slice(-400)}`);
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
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(30)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  restoreAll();
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
