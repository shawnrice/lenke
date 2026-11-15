/**
 * DOES `projected-fold.test.ts` HAVE TEETH? (item 1909)
 *
 * ⚠️ THE SUBJECT IS AN ORDER-PRESERVING FUSION, which is what makes it different from the
 * `min`/`max` residual it sits beside: a fold's element ORDER is its answer, so a mutant that keeps
 * the right elements in the wrong order is a wrong answer with the right length. The suite asserts
 * the list against the unfused projection AND spelled out, so both have to be wrong together.
 *
 * ⚠️⚠️ **WRITTEN DIRECTLY RATHER THAN TEMPLATED FROM AN EARLIER BATTERY, which is item 1907's
 * lesson applied.** Three times in one session a slice-based `replace` left a config field pointing
 * at the previous item's subject — the `cwd`, the `SRCS` path, `NATIVE_TESTS` — and two real mutants
 * reported SURVIVED against a suite that could not see them. Every field here is literal.
 *
 *     bun fold-mutants-1909.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  agg: `${ROOT}/packages/gremlin/src/executor/aggregation.ts`,
  idx: `${ROOT}/packages/gremlin/src/executor/index.ts`,
  // Item 1910's two gates: the bare-hop residual, in both rungs that serve a bare hop.
  hv: `${ROOT}/packages/gremlin/src/executor/hop-values.ts`,
  csr: `${ROOT}/packages/gremlin/src/executor/hop-values-csr.ts`,
  // Item 1912's tagged rung, which rides past the `tracksPath` guard.
  tag: `${ROOT}/packages/gremlin/src/executor/tagged-hop-values.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1909m`;
const CWD = `${ROOT}/packages/gremlin`;
/** ⚠️ The neighbours are in the set so a mutant that breaks the UNFUSED fold still fails. */
const TESTS = [
  'src/executor/tagged-hop-values.test.ts',
  'src/executor/projected-fold.test.ts',
  'src/executor/hop-values-csr.test.ts',
  'src/executor/hop-values-dedupe.test.ts',
];

/** `[name, which, from, to, expectedOccurrences]` */
const MUTANTS = [
  [
    'the fold residual is never fused (the pre-1909 route)',
    'idx',
    'if (fusableProjectedFold(projected.rest)) {',
    'if (false) {',
    1,
  ],
  [
    'a residual of any length is admitted as a fold',
    'agg',
    'if (rest.length !== 1) {\n    return false;\n  }\n',
    '',
    1,
  ],
  ['any step kind is admitted as a fold', 'agg', "return step.kind === 'fold';", 'return true;', 1],
  [
    'the list is yielded FLAT rather than as one row',
    'agg',
    'export const foldProjectedList = (values: HopWalk): unknown[] => [\n  values.drain === undefined ? [...values] : values.drain(),\n];',
    'export const foldProjectedList = (values: HopWalk): unknown[] =>\n  values.drain === undefined ? [...values] : values.drain();',
    1,
  ],
  [
    'the drain is never used (route only — the win, not the answer)',
    'agg',
    'values.drain === undefined ? [...values] : values.drain(),',
    '[...values],',
    1,
  ],
  [
    'the ELEMENT fold is not admitted on the bare hop (pre-1910)',
    'hv',
    "    proj.kind === 'fold' ||\n",
    '',
    1,
  ],
  [
    'the bare-hop arm CONSUMES the fold instead of leaving it in rest',
    'hv',
    '    pick = (far) => far;\n    consumed = 2;',
    '    pick = (far) => far;\n    consumed = 3;',
    1,
  ],
  [
    'the CSR rung does not admit the fold (so the slower bucket walk serves it)',
    'csr',
    "    proj.kind === 'fold' ||\n",
    '',
    1,
  ],
  [
    'the CSR rung CONSUMES the fold instead of leaving it in rest',
    'csr',
    'rest: steps.slice(picked.consumesProj ? 3 : 2),',
    'rest: steps.slice(3),',
    1,
  ],
  [
    'the bag+cap pair is not fused (the pre-1911 route)',
    'idx',
    'if (fusableProjectedBagCap(projected.rest)) {',
    'if (false) {',
    1,
  ],
  [
    'the KEYS need not match, so cap reads a side effect nobody wrote',
    'agg',
    "return capped.kind === 'cap' && capped.key === bag.key;",
    "return capped.kind === 'cap';",
    1,
  ],
  [
    'a residual of any length is admitted as a bag+cap',
    'agg',
    '  if (rest.length !== 2) {\n    return false;\n  }',
    '  if (rest.length < 2) {\n    return false;\n  }',
    1,
  ],
  [
    '`subgraph` is admitted as a bag, though its value is a GRAPH',
    'agg',
    "if (bag.kind !== 'aggregate' && bag.kind !== 'store') {",
    "if (bag.kind !== 'aggregate' && bag.kind !== 'store' && bag.kind !== 'subgraph') {",
    1,
  ],
  [
    'the CSR rung consumes the side-effect step instead of leaving it in rest',
    'csr',
    '    return { pick: (e) => e, drops: false, consumesProj: false };',
    '    return { pick: (e) => e, drops: false, consumesProj: true };',
    1,
  ],
  [
    'select and where(neq) swap: the near/far pick is inverted',
    'tag',
    "    return onlyTag && plain ? 'near' : undefined;",
    "    return onlyTag && plain ? 'far' : undefined;",
    1,
  ],
  [
    'the self-loop is kept by where(neq) — CSR arm',
    'tag',
    '        if (!near && far === from) {\n          continue;\n        }\n',
    '',
    1,
  ],
  [
    'the self-loop is kept by where(neq) — BUCKET arm',
    'tag',
    '      if (!near && far === v) {\n        continue;\n      }\n',
    '',
    1,
  ],
  [
    'select admits a DIFFERENT label than the tag',
    'tag',
    'const onlyTag = tail.labels.length === 1 && tail.labels[0] === label;',
    'const onlyTag = tail.labels.length === 1;',
    1,
  ],
  [
    'select admits a `by` modulator and pop=all',
    'tag',
    "    const plain = (tail.bys?.length ?? 0) === 0 && tail.pop !== 'all';",
    '    const plain = true;',
    1,
  ],
  [
    'any predicate operator is admitted, not just neq',
    'tag',
    "  return pred.op === 'neq' && 'value' in pred && pred.value === label ? 'far' : undefined;",
    "  return 'value' in pred && pred.value === label ? 'far' : undefined;",
    1,
  ],
  [
    'the two-tag where form is admitted',
    'tag',
    "if (tail.kind !== 'where' || !('pred' in tail) || 'startKey' in tail) {",
    "if (tail.kind !== 'where' || !('pred' in tail)) {",
    1,
  ],
  [
    'the CSR arm reads the SLOT as the far vertex',
    'tag',
    '        const far = vtx[memo.flat[i]];',
    '        const far = vtx[slot];',
    1,
  ],
  [
    'the FIFTH step is not admitted (the screen\u2019s own spelling)',
    'tag',
    '  if (steps.length !== 4 && steps.length !== 5) {',
    '  if (steps.length !== 4) {',
    1,
  ],
  [
    'a SIXTH step is admitted, so a residual is silently dropped (the tracksPath warrant)',
    'tag',
    '  if (steps.length !== 4 && steps.length !== 5) {',
    '  if (steps.length < 4) {',
    1,
  ],
  [
    'a multi-key values is admitted as the fifth step',
    'tag',
    "  proj.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;",
    "  proj.kind === 'values' ? proj.keys[0] : undefined;",
    1,
  ],
  [
    'the CSR arm emits a MISSING key as undefined instead of dropping it',
    'tag',
    `        const value = held.properties[valueKey];

        if (value !== undefined) {
          yield value;
        }`,
    '        yield held.properties[valueKey];',
    1,
  ],
  [
    'the BUCKET arm emits a MISSING key instead of dropping it',
    'tag',
    `      const value = held.properties[valueKey];

      if (value !== undefined) {
        yield value;
      }`,
    '      yield held.properties[valueKey];',
    1,
  ],
  [
    'the ITERATOR arm is dropped, so a walk without a drain answers empty',
    'agg',
    'values.drain === undefined ? [...values] : values.drain(),',
    'values.drain === undefined ? [] : values.drain(),',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ TAKING THE FUSION IS ANSWER-EQUIVALENT: the unfused route yields the SAME list in the SAME
   * order, 3.14x slower, and nothing in the public surface reports which route ran. Its gates are
   * the two permanent instruments rather than a test —
   * `gremlin-route-screen.mjs`'s `list: hop values fold` row (SHORTCUT, 0 `applyStep` calls, where
   * it read `generic 1 call` before) and `sideeffect-prof-1909.mjs` (137.77 -> 43.90 ms).
   * [[perf-gate-needs-its-own-test]].
   */
  'the fold residual is never fused (the pre-1909 route)',
  /*
   * ⚠️ ITEM 1910'S TWO GATE MUTANTS ARE ROUTE-ONLY FOR THE SAME REASON: declining the fold sends
   * the shape to a slower walk that yields the SAME list in the SAME order. Their gates are
   * `sideeffect-prof-1909.mjs` (99.53 -> 29.71 for the `hop-values.ts` gate, then -> 4.13 for the
   * CSR one) and `gremlin-route-screen.mjs`'s `list: hop fold` row.
   */
  'the ELEMENT fold is not admitted on the bare hop (pre-1910)',
  'the CSR rung does not admit the fold (so the slower bucket walk serves it)',
  /*
   * ⚠️ ITEM 1911'S ROUTE MUTANT, for the same reason: declining the bag+cap pair yields the SAME
   * list from the generic pipeline. Its gate is `sideeffect-prof-1909.mjs` — 107.61 -> 4.14 ms for
   * `aggregate`, 101.83 -> 4.16 for `store` — and the route screen's `list: hop aggregate cap` row.
   */
  'the bag+cap pair is not fused (the pre-1911 route)',
  /*
   * ⚠️ ITEM 1912'S FIFTH-STEP ADMISSION IS ROUTE-ONLY TOO: without it the five-step spellings fall
   * to the generic path and answer identically, 4.25x and 13.8x slower. Its gate is
   * `neq-prof-1900.mjs`'s `neqv`/`selv` arms (325.22 -> 76.50 and 186.50 -> 13.48) and the workload
   * screen's own rows (406.18 -> 94.66 for `where: neq filter`).
   */
  'the FIFTH step is not admitted (the screen\u2019s own spelling)',
]);

/*
 * ⚠️ AND ONE ENTRY WAS REMOVED FROM THIS SET BECAUSE THE HARNESS CONTRADICTED IT. "The drain is
 * never used" was declared an expected survivor on the same grounds — and it is CAUGHT, because
 * `projected-fold.test.ts` asserts `foldProjectedList` calls `drain` on a walk that offers one.
 * A unit test on the helper turns an unobservable route into a checked one; that is the difference
 * between the two entries.
 */

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/** ⚠️ BOTH STREAMS: `bun test` writes `N pass` to stderr (item 767). */
const run = () => {
  const r = spawnSync('timeout', ['300', 'bun', 'test', ...TESTS], {
    cwd: CWD,
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

  for (const [name, which, from, to, want] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      throw new Error(
        `ANCHOR for "${name}" matched ${String(seen)} times, expected ${String(want)}`,
      );
    }

    writeFileSync(SRCS[which], pristine.replace(from, to));

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
      `  ${verdictLabel(caught, expected)}  ${name.padEnd(62)} ` +
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
