/**
 * DOES `optional-hop-values.test.ts` HAVE TEETH? (item 1884)
 *
 * ⚠️ IT PASSED ON ITS FIRST RUN, AND SO DOES A TEST THAT CHECKS NOTHING. CLAUDE.md's rule:
 * "Mutate it and check the fuzzer catches it. A generative test whose teeth were never verified is
 * worse than no test, because it is believed."
 *
 * ⚠️ EACH MUTANT IS ANCHOR-ASSERTED. Items 1870 and 1873 both recorded a mutant whose anchor
 * matched 0 or 2 times, so the "pass" meant nothing — the patch had never applied. Every entry
 * below declares the occurrence count it expects and the run fails loudly otherwise.
 *
 * ⚠️ AND A VERDICT NEEDS EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` /
 * `N fail` to **stderr**, so both streams are concatenated and a result line is required before
 * the exit code is read (items 767/772-773 got this wrong in both directions).
 *
 *     bun edge-filtered-mutants-1884.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRC = `${ROOT}/packages/gremlin/src/executor/optional-hop-values.ts`;
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1884-edge-filtered.ts`;
const TEST = 'src/executor/optional-hop-values.test.ts';

/** `[name, from, to, expectedOccurrences]` — each a change that must break at least one test. */
const MUTANTS = [
  ['far end swapped', 'pick(forward ? e.to : e.from)', 'pick(forward ? e.from : e.to)', 1],
  // ⚠️ `if (!any) {` NOW APPEARS TWICE — the single-hop walk and item 1887's chain walk — and the
  // anchor assertion is what said so rather than a silent half-applied patch. The count is declared
  // as 2 and `replace` takes the FIRST, which is the single-hop walk; the chain's own empty branch
  // has its own entry below.
  ['empty branch deleted (single-hop walk)', 'if (!any) {', 'if (false) {', 2],
  [
    'any set from the VALUE, not the edge',
    'any = true;\n\n          const value = pick(forward ? e.to : e.from);',
    'const value = pick(forward ? e.to : e.from);\n\n          any = value !== undefined;',
    1,
  ],
  [
    // Two walks have this branch since item 1887; `replace` takes the first (the single-hop walk).
    'self-emit drops nothing (single-hop walk)',
    'const value = pick(v);\n\n        if (!drops || value !== undefined) {',
    'const value = pick(v);\n\n        if (true) {',
    2,
  ],
  [
    'missing-key drop disabled',
    '{ pick: (e) => e.properties[valueKey], drops: true }',
    '{ pick: (e) => e.properties[valueKey], drops: false }',
    1,
  ],
  [
    'general adjacency arm skipped',
    'for (const e of adjacentEdges(kind, graph, v, labels)) {',
    'for (const e of []) {',
    1,
  ],
  [
    'bucket arm ignores direction',
    'const { set, forward } = direct;',
    'const { set } = direct;\n        const forward = true;',
    1,
  ],
  [
    'chain: the depth-2 arm reads the FIRST hop twice (mid ignored)',
    'soleTypeBucket(mid, two[1].kind, two[1].labels)',
    'soleTypeBucket(v, two[1].kind, two[1].labels)',
    1,
  ],
  [
    'chain: `any` is set on the FIRST hop, so a dead chain emits nothing',
    `          for (const e2 of edges2) {
            any = true;`,
    `          any = true;

          for (const e2 of edges2) {`,
    1,
  ],
  [
    'chain: the recursion is one hop short',
    'const last = at === hops.length - 1;',
    'const last = at === hops.length - 2;',
    1,
  ],
  /**
   * ⚠️ AN EXPECTED SURVIVOR, and item 475's rule says why it is kept rather than deleted: it is
   * UNREACHABLE, not untested. `optionalSingleHop` is tried first and only its `undefined` reaches
   * `hopChain`, so a one-step plan never gets here — and a one-step plan it WOULD decline (say
   * `optional(count())`) fails the vertex-step test inside the loop anyway. The guard stays because
   * it states the contract between the two arms, which is what keeps them disjoint if either gate
   * is widened.
   */
  [
    'EXPECTED SURVIVOR — chain: the gate admits a ONE-step sub-plan too',
    `  if (plan.steps.length < 2) {
    return undefined;
  }

  const hops: Hop[] = [];`,
    `  if (plan.steps.length < 1) {
    return undefined;
  }

  const hops: Hop[] = [];`,
    1,
  ],
];

/**
 * ⚠️ BOTH STREAMS, ALWAYS, AND THAT IS WHY THIS IS `spawnSync`. `execFileSync` returns STDOUT on
 * success and only exposes stderr on a throw — and `bun test` writes `N pass` to **stderr**, so the
 * first cut of this file read an empty result on the passing baseline and declared it broken. Item
 * 767 made the same mistake in the other direction.
 */
/** The three outcomes as a label; a nested ternary is what the linter objects to. */
const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', TEST], {
    cwd: `${ROOT}/packages/gremlin`,
    encoding: 'utf8',
  });

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

copyFileSync(SRC, PRISTINE);

/** Names that MUST survive, each with its reason stated at the entry above. */
const EXPECTED_SURVIVORS = new Set([
  'EXPECTED SURVIVOR — chain: the gate admits a ONE-step sub-plan too',
]);

const survivors = [];

try {
  const pristine = readFileSync(PRISTINE, 'utf8');

  // The BASELINE must pass, or every mutant "fails" for the wrong reason.
  const base = run();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-800)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop — an interrupted run must
    // not leave a mutant in the tree for `git diff` to be the only thing standing in its way.
    writeFileSync(SRC, pristine);

    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    writeFileSync(SRC, pristine.replace(from, to));

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
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(30)} ` +
        `${result === null ? '' : `${result[2]} failing`}${r.code === 124 ? ' — timed out' : ''}`,
    );
  }
} finally {
  copyFileSync(PRISTINE, SRC);
  console.log('\n# restored');
}

if (survivors.length > 0) {
  console.log(`\n⚠️ ${String(survivors.length)} SURVIVOR(S): ${survivors.join(', ')}`);
  process.exitCode = 1;
}
