/**
 * DOES `two-hop-count-csr.test.ts` HAVE TEETH? (item 1890)
 *
 * THE TWO ROUTES RETURN THE SAME NUMBER, so the gate and the policy can only be caught by their
 * own unit tests — [[perf-gate-needs-its-own-test]]. Half the mutants below target those rather than
 * the arithmetic, which is the half that would otherwise be believed without evidence.
 *
 *     bun count-csr-mutants-1890.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = { csr: `${ROOT}/packages/gql/src/executor/csr-cache.ts` };
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1890`;
// BOTH test files, because the two halves catch different mutants: the answer file catches a
// missing slice, the ROUTE file catches a rung that starts claiming shapes it must leave alone —
// and a route change is answer-equivalent, which is `perf-gate-needs-its-own-test` exactly.
const TESTS = ['src/two-hop-count-csr.test.ts'];

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  [
    'the product reads the SAME leg twice',
    'csr',
    'const legC = csrFor(graph, !spec.fromCOut, spec.t2);',
    'const legC = legA;',
    1,
  ],
  [
    'the degree is off by one (one extra neighbour per slot)',
    'csr',
    'const ways = legA.off[s + 1] - legA.off[s];',
    'const ways = legA.off[s + 1] - legA.off[s] + 1;',
    1,
  ],
  [
    'the second degree reads the WRONG slot',
    'csr',
    'count += ways * (legC.off[s + 1] - legC.off[s]);',
    'count += ways * (legC.off[s + 1] - legC.off[0]);',
    1,
  ],
  [
    'the DIRECTION conversion is dropped on the first leg',
    'csr',
    'const legA = csrFor(graph, !spec.toAOut, spec.t1);',
    'const legA = csrFor(graph, spec.toAOut, spec.t1);',
    1,
  ],
  [
    'the gate admits an undirected leg',
    'csr',
    '  !s.firstBoth &&\n  !s.secondBoth &&',
    '  !s.secondBoth &&',
    1,
  ],
  ['the gate admits a non-vacuous END label', 'csr', '  s.cEff === undefined &&', '', 1],
  ['the gate admits a MIDDLE label', 'csr', '  s.midEff === undefined &&', '', 1],
  ['the gate admits a gated middle', 'csr', '  !s.gated;', '  true;', 1],
  [
    'the second-ask policy claims the FIRST ask too',
    'csr',
    'return csrAskedBefore(graph, key) ? twoHopUnfilteredCsrCount(graph, spec) : null;',
    'return twoHopUnfilteredCsrCount(graph, spec);',
    1,
  ],
  [
    // TWO OCCURRENCES — `csrFor`'s own cache uses the same generation pattern, and mine is the
    // SECOND in the file. The anchor assertion is what said so.
    'the policy never resets on a topology write',
    'csr',
    'if (entry === undefined || entry.tv !== tv) {',
    'if (entry === undefined) {',
    2,
    1,
  ],
  [
    'the policy key ignores the SECOND leg',
    'csr',
    // eslint-disable-next-line no-template-curly-in-string -- a SOURCE ANCHOR, not a template
    "const key = `${spec.toAOut ? '<' : '>'}${(spec.t1 ?? []).join('\\u0000')}|${spec.fromCOut ? '>' : '<'}${(spec.t2 ?? []).join('\\u0000')}`;",
    'const key = String(spec.toAOut);',
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
