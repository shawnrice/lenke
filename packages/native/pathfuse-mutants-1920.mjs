/**
 * DOES `path-hop-values.test.ts` HAVE TEETH? (items 1920 and 1924)
 *
 * ⚠️ THE SUBJECT EMITS A TWO-ELEMENT ARRAY PER ROW, so the failure mode is a wrong ORDER or a wrong
 * END with the right row count — invisible to any assertion that counts rows, which is exactly what
 * made the 14.8x look suspicious enough to verify in the first place.
 *
 * ⚠️⚠️ PER-ARM MUTANTS GO BY FILE ORDER, NOT INTUITION (item 1913). The row expression
 * `[from, vtx[memo.flat[i]]]` appears TWICE — once in the eager `drain` and once in the lazy `each`
 * — and `walk` (which holds the drain) is defined BEFORE `each`, so **occurrence 0 is the DRAIN**.
 * Item 1913's battery had these labels swapped and the mislabelling hid a real gap.
 *
 * ⚠️ WRITTEN DIRECTLY, not templated (item 1907), and every test path listed from the directory
 * (item 1915 found a non-existent path in its own first draft).
 *
 * ⚠️⚠️ NINE ANCHORS DRIFTED AT ONCE when item 1924 added the `by(k)` mode, because it rewrote every
 * row site and the gate. The battery reported ALL NINE in one run rather than throwing on the first
 * — item 1914's harness fix earning itself — and each was RE-ANCHORED onto the new text keeping its
 * original name and intent, because a dead mutant silently loses the coverage item 1920 built.
 *
 *     bun pathfuse-mutants-1920.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  path: `${ROOT}/packages/gremlin/src/executor/path-hop-values.ts`,
  idx: `${ROOT}/packages/gremlin/src/executor/index.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1920m`;
const CWD = `${ROOT}/packages/gremlin`;
/** The neighbours are here so a mutant that breaks the GENERIC path still fails. */
const TESTS = [
  'src/executor/path-hop-values.test.ts',
  'src/executor/tagged-hop-values.test.ts',
  'src/executor/path-tracking.test.ts',
  'src/executor/hop-values-csr.test.ts',
];

/** `[name, which, from, to, expectedOccurrences, occurrenceIndex?]` */
const MUTANTS = [
  // ---- the row, per arm ----
  [
    'the path is REVERSED — EAGER drain (occurrence 0)',
    'path',
    '            byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)],',
    '            byKey === undefined ? [far, from] : [byVal(from, byKey), byVal(far, byKey)],',
    1,
  ],
  [
    'the path is REVERSED — LAZY iterator (occurrence 0 of the yield)',
    'path',
    '        yield byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)];',
    '        yield byKey === undefined ? [far, from] : [byVal(from, byKey), byVal(far, byKey)];',
    1,
  ],
  [
    'the NEAR slot holds the far vertex too — drain, CSR arm',
    'path',
    '            byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)],',
    '            byKey === undefined ? [far, far] : [byVal(from, byKey), byVal(far, byKey)],',
    1,
  ],
  [
    'the bucket arm reads the WRONG END — drain (occurrence 0)',
    'path',
    '        const far = direct.forward ? e.to : e.from;\n\n        out.push(',
    '        const far = e.to;\n\n        out.push(',
    1,
  ],
  [
    'the bucket arm reads the WRONG END — iterator',
    'path',
    '      const far = direct.forward ? e.to : e.from;\n\n      yield',
    '      const far = e.to;\n\n      yield',
    1,
  ],
  [
    'the path is ONE element, not two — drain, CSR arm',
    'path',
    '            byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)],',
    '            byKey === undefined ? [far] : [byVal(from, byKey), byVal(far, byKey)],',
    1,
  ],
  // ---- the gate ----
  [
    'the gate admits `both` and a multi-type hop',
    'path',
    "  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {\n    return undefined;\n  }",
    "  if (hop.kind !== 'out' && hop.kind !== 'in' && hop.kind !== 'both') {\n    return undefined;\n  }",
    1,
  ],
  [
    'the gate admits a plan of ANY length, so a fourth step is dropped',
    'path',
    '  if (steps.length !== 3) {\n    return undefined;\n  }',
    '  if (steps.length < 3) {\n    return undefined;\n  }',
    1,
  ],
  [
    'the gate admits a NON-path tail as if it were bare',
    'path',
    "  if (step.kind !== 'path') {\n    return undefined;\n  }",
    '',
    1,
  ],
  [
    'the gate admits any tail step, not just path',
    'path',
    '  if (form === undefined) {\n    return undefined;\n  }',
    '',
    1,
  ],
  [
    'the gate admits V(id, ...), which enumerates a given set',
    'path',
    "  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {\n    return undefined;\n  }",
    "  if (source.kind !== 'V') {\n    return undefined;\n  }",
    1,
  ],
  [
    'the direction is inverted, so `out` walks the in-bucket',
    'path',
    "      forward: hop.kind === 'out',",
    "      forward: hop.kind === 'in',",
    1,
  ],
  // ---- the wiring ----
  // ---- item 1924's `by(k)` mode, per arm ----
  [
    '⚠️ an ABSENT key becomes null instead of undefined',
    'path',
    'return Object.hasOwn(bag, key) ? bag[key] : undefined;',
    'return Object.hasOwn(bag, key) ? bag[key] : null;',
    1,
  ],
  [
    '⚠️ `in` replaces Object.hasOwn, leaking a prototype function',
    'path',
    'return Object.hasOwn(bag, key) ? bag[key] : undefined;',
    'return key in bag ? bag[key] : undefined;',
    1,
  ],
  [
    'the by mode is ignored, so the row holds the ELEMENTS',
    'path',
    "      byKey: form === 'bare' ? undefined : form.key,",
    '      byKey: undefined,',
    1,
  ],
  [
    'the gate admits TWO bys, which cycle round-robin',
    'path',
    '  if (bys === undefined || bys.length !== 1) {\n    return undefined;\n  }',
    '',
    1,
  ],
  [
    'the gate admits a non-key by (a traversal or identity)',
    'path',
    "  return by.kind === 'key' && by.direction === undefined ? { key: by.key } : undefined;",
    '  return { key: (by as { key: string }).key };',
    1,
  ],
  [
    'the by row projects the FAR end twice — EAGER drain, CSR arm',
    'path',
    '            byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)],',
    '            byKey === undefined ? [from, far] : [byVal(far, byKey), byVal(far, byKey)],',
    1,
  ],
  [
    'the by row projects the FAR end twice — LAZY iterator, CSR arm',
    'path',
    '        yield byKey === undefined ? [from, far] : [byVal(from, byKey), byVal(far, byKey)];',
    '        yield byKey === undefined ? [from, far] : [byVal(far, byKey), byVal(far, byKey)];',
    1,
  ],
  [
    'the by row swaps the ends — drain, BUCKET arm',
    'path',
    '        out.push(byKey === undefined ? [v, far] : [byVal(v, byKey), byVal(far, byKey)]);',
    '        out.push(byKey === undefined ? [v, far] : [byVal(far, byKey), byVal(v, byKey)]);',
    1,
  ],
  [
    'the by row swaps the ends — iterator, BUCKET arm',
    'path',
    '      yield byKey === undefined ? [v, far] : [byVal(v, byKey), byVal(far, byKey)];',
    '      yield byKey === undefined ? [v, far] : [byVal(far, byKey), byVal(v, byKey)];',
    1,
  ],
  [
    'the rung is never taken (the pre-1920 route)',
    'idx',
    '  const bare = pathHopValues(effective, graph);\n\n  if (bare !== undefined) {\n    return bare.values;\n  }',
    '',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ ROUTE-ONLY: declining the rung sends the shape back through the generic traverser pipeline,
   * which builds the SAME `[near, far]` arrays in the SAME order — that equality is the whole point
   * of the item, so by construction no answer test can see which route ran. Its gates are the
   * workload screen's `path: hop path` row (124.55 -> 8.40 ms) and
   * `pathfuse-parity-1920.mjs`. [[perf-gate-needs-its-own-test]].
   *
   * ⚠️ NOTE WHAT IS **NOT** HERE: every gate mutant above. Because `pathHopValues` is EXPORTED and
   * unit-tested directly, a mutant that mis-recognizes a shape fails even with the route disabled —
   * which is what keeps this set to one entry instead of six.
   */
  'the rung is never taken (the pre-1920 route)',
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

  for (const [name, which, from, to, want, atRaw] of MUTANTS) {
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    if (seen !== want) {
      anchorProblems.push(`"${name}" [${which}] matched ${String(seen)}, expected ${String(want)}`);
      continue;
    }

    const at = atRaw ?? 0;
    let n = -1;
    const mutated = pristine.replaceAll(from, (m) => {
      n += 1;

      return n === at ? to : m;
    });

    writeFileSync(SRCS[which], mutated);

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

    console.log(`  ${verdictLabel(caught, expected)}  ${name.padEnd(58)} ${failing}${how}`);
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
