/**
 * DOES `sub-plan-existence.test.ts` HAVE TEETH? (item 1915)
 *
 * ⚠️ THE SUBJECT IS A FILTER, so every mutant is a WRONG MEMBERSHIP rather than a wrong value — the
 * failure mode is a row set that is too big or too small, which an aggregate would hide. The suite
 * asserts each answer against the SAME question down the general path AND spells the expected
 * vertices out, so both have to be wrong together.
 *
 * ⚠️⚠️ WRITTEN DIRECTLY RATHER THAN TEMPLATED FROM AN EARLIER BATTERY, which is item 1907's lesson
 * applied. Three times in one session a slice-based `replace` left a config field pointing at the
 * previous item's subject — the `cwd`, the `SRCS` path, the test list — and real mutants reported
 * SURVIVED against a suite that could not see them. Every field here is literal and was re-derived.
 *
 * ⚠️ UNDER BOTH A TIMEOUT AND A CGROUP CAP, because a mutant is arbitrary broken code. CLAUDE.md:
 * `MemoryMax` catches runaway allocation, `MemorySwapMax=0` makes that kill immediate, and the
 * `timeout` catches a non-allocating infinite loop that `MemoryMax` never trips. Exit 137 and 124
 * ARE the mutant being caught, not harness failures. `--prove` runs an allocator bomb and a bare
 * spin loop first, so the net is verified rather than believed.
 *
 *     bun wheresub-mutants-1915.mjs --prove
 *     bun wheresub-mutants-1915.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = '/home/shawn/projects/pl-graph';
const SRCS = {
  sub: `${ROOT}/packages/gremlin/src/executor/sub-plan-existence.ts`,
  disp: `${ROOT}/packages/gremlin/src/executor/dispatch.ts`,
};
const PRISTINE = `${ROOT}/crates/lenke-engine/target/pristine-1915m`;
const CWD = `${ROOT}/packages/gremlin`;
/**
 * ⚠️ THE NEIGHBOURS ARE IN THE SET so a mutant that breaks the GENERAL sub-plan path still fails:
 * `dispatch.ts` carries both arms of every branch this item touched, and `optional-*` is the
 * closest sibling fusion (it shares `movement.ts` and the same per-traverser argument).
 */
const TESTS = [
  'src/executor/sub-plan-existence.test.ts',
  'src/executor/optional-hop-values.test.ts',
  'src/executor/optional-bucket-hop.test.ts',
  'src/executor/match-bucket-hop.test.ts',
  'src/executor/filter-flatten.test.ts',
  'src/executor/subPlansOf.test.ts',
];
/*
 * ⚠️ EVERY PATH ABOVE WAS LISTED FROM THE DIRECTORY, NOT RECALLED. The first draft of this list
 * named `src/executor/match.test.ts`, which does not exist — the file is `match-bucket-hop.test.ts`.
 * A non-existent path in a mutation battery's test set is the silent-config failure this file's
 * header is about, so the check is: list the directory, then paste.
 */

/** `[name, which, from, to, expectedOccurrences, occurrenceIndex?]` */
const MUTANTS = [
  // ---- the recognizer ----
  [
    'any step kind is admitted as an adjacency step',
    'sub',
    '    default: {\n      return undefined;\n    }',
    "    default: {\n      return { kind: 'out', labels: [] };\n    }",
    1,
  ],
  [
    'a MULTI-STEP sub-plan is admitted, so the later steps are dropped',
    'sub',
    'if (plan.steps.length !== 1) {',
    'if (plan.steps.length < 1) {',
    1,
  ],
  [
    'a sub-plan with NO steps is admitted',
    'sub',
    'if (plan.steps.length !== 1) {',
    'if (plan.steps.length > 1) {',
    1,
  ],
  [
    'outE maps to the IN direction',
    'sub',
    "    case 'outE': {\n      return { kind: 'out', labels: only.labels };\n    }",
    "    case 'outE': {\n      return { kind: 'in', labels: only.labels };\n    }",
    1,
  ],
  [
    'bothE maps to OUT only, losing the in-bucket',
    'sub',
    "    case 'bothE': {\n      return { kind: 'both', labels: only.labels };\n    }",
    "    case 'bothE': {\n      return { kind: 'out', labels: only.labels };\n    }",
    1,
  ],
  // ---- the predicate ----
  [
    'an `in` hop also reads the OUT bucket',
    'sub',
    "    (kind !== 'in' && anyNonEmpty(v.adjFrom, labels)) ||",
    '    anyNonEmpty(v.adjFrom, labels) ||',
    1,
  ],
  [
    'a `both` hop never reads the IN bucket',
    'sub',
    "    (kind !== 'out' && anyNonEmpty(v.adjTo, labels))",
    '    false',
    1,
  ],
  [
    'the two directions are ANDed rather than ORed',
    'sub',
    "    (kind !== 'in' && anyNonEmpty(v.adjFrom, labels)) ||\n    (kind !== 'out' && anyNonEmpty(v.adjTo, labels))",
    "    (kind !== 'in' && anyNonEmpty(v.adjFrom, labels)) &&\n    (kind !== 'out' && anyNonEmpty(v.adjTo, labels))",
    1,
  ],
  [
    'a PRESENT bucket counts, empty or not (see EXPECTED_SURVIVORS)',
    'sub',
    'if (set !== undefined && set.size > 0) {',
    'if (set !== undefined) {',
    1,
  ],
  [
    'an untyped hop reads only the FIRST bucket',
    'sub',
    '    for (const set of byLabel.values()) {\n      if (set.size > 0) {\n        return true;\n      }\n    }\n\n    return false;',
    '    for (const set of byLabel.values()) {\n      return set.size > 0;\n    }\n\n    return false;',
    1,
  ],
  [
    'an untyped hop matches a vertex with NO buckets',
    'sub',
    '    for (const set of byLabel.values()) {\n      if (set.size > 0) {\n        return true;\n      }\n    }\n\n    return false;',
    '    for (const set of byLabel.values()) {\n      if (set.size > 0) {\n        return true;\n      }\n    }\n\n    return true;',
    1,
  ],
  [
    'a MULTI-TYPE hop reads only the first label',
    'sub',
    '  for (const label of labels) {\n    const set = byLabel.get(label);',
    '  for (const label of labels.slice(0, 1)) {\n    const set = byLabel.get(label);',
    1,
  ],
  [
    'a missing adjacency box is a MATCH',
    'sub',
    '  if (byLabel === undefined) {\n    return false;\n  }',
    '  if (byLabel === undefined) {\n    return true;\n  }',
    1,
  ],
  // ---- the steps ----
  [
    'the single-hop step ignores `want`, so `not` keeps the matches',
    'sub',
    'if (hit === want) {',
    'if (hit) {',
    1,
  ],
  [
    'the single-hop step drops the isVertex guard',
    'sub',
    'const hit = isVertex(t.value) && hasAdjacency(t.value, hop);',
    'const hit = hasAdjacency(t.value as Vertex, hop);',
    1,
  ],
  [
    'the combining loop inverts its test',
    'sub',
    'if (hasAdjacency(v, hops[i]) !== every) {',
    'if (hasAdjacency(v, hops[i]) === every) {',
    1,
  ],
  [
    'the combining loop lets a NON-VERTEX through',
    'sub',
    '    if (!isVertex(t.value)) {\n      continue;\n    }',
    '    if (!isVertex(t.value)) {\n      yield t;\n      continue;\n    }',
    1,
  ],
  [
    'the combining loop stops after the FIRST plan',
    'sub',
    'for (let i = 0; i < hops.length; i += 1) {',
    'for (let i = 0; i < 1; i += 1) {',
    1,
  ],
  [
    'arity-1 and/or is routed as `or` semantics regardless (route only)',
    'sub',
    'hops.length === 1 ? hopExistenceStep(stream, hops[0], true) : combinedWalk(stream, hops, every)',
    'combinedWalk(stream, hops, every)',
    1,
  ],
  // ---- the all-or-nothing gate ----
  [
    'an EMPTY plan list is fused, collapsing and() and or()',
    'sub',
    '  if (plans.length === 0) {\n    return undefined;\n  }',
    '',
    1,
  ],
  [
    'a MIXED and() half-fuses, dropping the unrecognized plan',
    'sub',
    '    if (hop === undefined) {\n      return undefined;\n    }\n\n    hops.push(hop);',
    '    if (hop !== undefined) {\n      hops.push(hop);\n    }',
    1,
  ],
  // ---- the dispatch wiring ----
  [
    '`not` is wired with want=true, so it keeps the matches',
    'disp',
    ': hopExistenceStep(stream, exists, false);',
    ': hopExistenceStep(stream, exists, true);',
    1,
  ],
  [
    '`or` is wired as `and`',
    'disp',
    ': hopExistenceCombinedStep(stream, hops, false);',
    ': hopExistenceCombinedStep(stream, hops, true);',
    1,
  ],
  [
    'the `where` fusion is never taken (the pre-1915 route)',
    'disp',
    '        return exists === undefined\n          ? whereSubPlanStep(stream, step.plan, graph, ctx)\n          : hopExistenceStep(stream, exists, true);',
    '        return whereSubPlanStep(stream, step.plan, graph, ctx);',
    1,
  ],
  [
    'the `filter` fusion is never taken (the pre-1915 route)',
    'disp',
    '      return exists === undefined\n        ? whereSubPlanStep(stream, step.plan, graph, ctx)\n        : hopExistenceStep(stream, exists, true);',
    '      return whereSubPlanStep(stream, step.plan, graph, ctx);',
    1,
  ],
];

/** Names that MUST survive, each with its reason. */
const EXPECTED_SURVIVORS = new Set([
  /*
   * ⚠️ A PRESENT-BUT-EMPTY BUCKET CANNOT ARISE TODAY, so `size > 0` and `!== undefined` are
   * answer-equivalent and no test in this repo can tell them apart. `emptybucket-probe-1915.mjs`
   * established that core DELETES a bucket as it empties, by all four routes that can drop a
   * vertex's last edge of a label. The guard stays because the alternative silently depends on a
   * CORE invariant this module does not own — and that invariant is now pinned where it lives, by
   * `adjacency-box.test.ts`'s "an emptied bucket is deleted, not left present and empty". So the
   * survivor is declared and the dependency is guarded one layer down, which is the honest pair.
   */
  'a PRESENT bucket counts, empty or not (see EXPECTED_SURVIVORS)',
  /*
   * ⚠️ THE SAME CLASS, AND IT WAS NOT PREDICTED — it ran as a real mutant and SURVIVED, which is how
   * the generality of the point above got noticed. Because a bucket is never present-and-empty,
   * "SOME bucket is non-empty", "the FIRST bucket is non-empty" and `byLabel.size > 0` are all the
   * same predicate. The untyped loop is therefore redundant TODAY, by exactly the invariant that
   * makes `size > 0` redundant today, and nothing reachable through the public API can tell them
   * apart — a vertex with an empty bucket cannot be constructed.
   *
   * It keeps the loop for the same reason the other keeps its guard: correct under both
   * assumptions, with the invariant pinned one layer down in `adjacency-box.test.ts` rather than
   * assumed here. ⚠️ The honest cost of that choice is that these two mutants CANNOT be caught, so
   * they are declared rather than quietly absent.
   */
  'an untyped hop reads only the FIRST bucket',
  /*
   * ⚠️ ROUTE-ONLY, AND THE ARITY SPLIT IS A SPEED CHOICE: `and(p)` and `or(p)` over ONE plan both
   * mean exactly `p`, so sending arity 1 through the combining loop answers identically. Its gate is
   * the measurement, not a test — `wheresub-prof-1915.mjs`'s `and` arm read 36.61 ms through the
   * loop against 20.85 through the single-hop step, with `where` at 21.38 as the reference.
   * [[perf-gate-needs-its-own-test]].
   */
  'arity-1 and/or is routed as `or` semantics regardless (route only)',
  /*
   * ⚠️ TAKING THE FUSION IS ANSWER-EQUIVALENT: the general path answers the SAME rows in the SAME
   * order, 4x slower, and nothing in the public surface reports which route ran. The gate is
   * `wheresub-prof-1915.mjs` (`where` 86.33 -> 20.87, `filter` 88.13 -> 22.52, both controls flat
   * across 3 interleaved rounds) and the workload screen's `where: sub-traversal` row.
   *
   * ⚠️ NOTE WHAT IS **NOT** IN THIS SET: the gate mutants above. Because `singleHopExistence`,
   * `allHopExistence` and `hasAdjacency` are EXPORTED and unit-tested directly, a mutant that
   * mis-recognizes or mis-answers fails even with every route disabled. That is
   * [[perf-gate-needs-its-own-test]]'s prescription — extract the decision as a pure function and
   * test it — and it is why only the two "never take the route" mutants are route-only here.
   */
  'the `where` fusion is never taken (the pre-1915 route)',
  'the `filter` fusion is never taken (the pre-1915 route)',
]);

/**
 * ⚠️ 124 AND 137 ARE THE MUTANT BEING CAUGHT, not harness failures — CLAUDE.md says so in terms. A
 * mutant that cannot terminate, or that allocates without bound, is one the test would have caught.
 */
const verdictOf = (code) => {
  if (code === 124) {
    return 'TIMEOUT (caught)';
  }

  if (code === 137) {
    return 'OOM (caught)';
  }

  return code !== 0;
};

/** 124 is the timeout firing and 137 the cgroup killing; both are the mutant being caught. */
const HOW_DIED = new Map([
  [124, ' — timed out'],
  [137, ' — OOM-killed'],
]);

const verdictLabel = (caught, expected) => {
  if (caught !== false) {
    return '✅ caught   ';
  }

  return expected ? '➖ survived (expected)' : '❌ SURVIVED';
};

/**
 * ⚠️ BOTH STREAMS CONCATENATED, THEN the exit code. `bun test` writes `N pass` / `N fail` to
 * STDERR, never stdout (item 767 read an empty stdout and concluded the runner never ran a test;
 * items 772-773 then printed DID-NOT-RUN for runs that passed cleanly).
 */
const run = (argv, secs = '600', cap = '16G') => {
  const r = spawnSync(
    'timeout',
    [
      secs,
      'systemd-run',
      '--user',
      '--scope',
      '-q',
      '-p',
      `MemoryMax=${cap}`,
      '-p',
      'MemorySwapMax=0',
      ...argv,
    ],
    { cwd: CWD, encoding: 'utf8' },
  );

  return { text: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}`, code: r.status ?? -1 };
};

/**
 * Allocates 256 MiB at a time, TOUCHING each chunk so the pages are really resident.
 *
 * ⚠️ IT REPORTS NOTHING, and an earlier version's attempt to report its chunk count was removed
 * rather than fixed: a hard OOM does not unwind, so the `finally` that printed it never ran and the
 * count always read -1. The scaling evidence comes from WALL TIME instead, below.
 */
const BOMB =
  'const a = []; for (;;) { const b = new Uint8Array(1 << 28); b[0] = 1; b[b.length - 1] = 1; a.push(b); }';

const runTests = () => run(['bun', 'test', ...TESTS]);

if (process.argv.includes('--prove')) {
  /*
   * ⚠️ THE SPIN ARM USES A SHORT TIMEOUT, and that is faithful rather than a shortcut: what is under
   * test is that `timeout` FIRES on a loop `MemoryMax` can never trip, not that the number is 600.
   * The real runs keep 600 because that is patience, not protection.
   *
   * ⚠️ AND THIS PRINTS BEFORE IT EXITS, which the first version did not. Piped into `tail`, its two
   * verdict lines never appeared and only `exit 0` did — an exit code standing in for the evidence,
   * which is the thing CLAUDE.md says a verdict may not be. `process.stdout.write` + no pipe.
   */
  /*
   * ⚠️ 256 MiB CHUNKS, NOT 16 MiB. The first version allocated `1 << 24` and reached only 4.8 GB in
   * 265 seconds — a proof too slow to run, which is a proof nobody runs. 64 chunks of `1 << 28`
   * cross a 16 GiB cap in seconds. Each is also WRITTEN to, so the pages are really committed
   * rather than reserved; a cap counts resident pages, and a lazily-mapped allocation would sail
   * past it and make the net look broken when it is not.
   */
  /*
   * ⚠️⚠️ THE BOMB DIES WITH EXIT 1, NOT 137, AND THAT IS NOT THE PROOF FAILING — bun's own allocator
   * hits the failed mapping inside the cgroup and throws, rather than the kernel delivering SIGKILL.
   * Either way the process dies non-zero, which is all the battery's verdict needs. But a non-zero
   * exit ALONE does not show the CAP did it: a JS runtime has its own heap ceiling and would also
   * exit 1 with no cgroup at all.
   *
   * So the proof is that the death point SCALES WITH THE CAP. The bomb reports the chunks it
   * allocated, and 2G must stop it an order of magnitude earlier than 16G. ⚠️ An UNCAPPED arm would
   * be the cleaner comparison and is deliberately NOT run: CLAUDE.md records a runaway filling a
   * 192 GB swapfile and needing a hard reboot, and this box has taken that four times.
   */
  /*
   * ⚠️ THE CHUNK COUNT IS UNREACHABLE: the bomb's `finally` never runs, because a hard OOM does not
   * unwind. So the scaling signal is ELAPSED TIME — the bomb allocates at a steady rate, so a cap
   * it reaches sooner kills it sooner. The two arms also die DIFFERENTLY, which is itself the
   * evidence: 2G is killed by a SIGNAL (no exit status at all) where 16G gets bun's own exit 1, and
   * bun's heap ceiling is far above 2 GiB, so nothing but the cgroup can be killing the 2G arm.
   */
  const timed = (cap) => {
    const t0 = Date.now();
    const r = run(['bun', '-e', BOMB], '120', cap);

    return { ...r, ms: Date.now() - t0 };
  };

  const small = timed('2G');
  const bomb = timed('16G');
  const scaled = bomb.ms > small.ms * 1.5;

  process.stdout.write(
    `bomb  exit 16G=${String(bomb.code)} 2G=${String(small.code)}  ` +
      `died after 2G=${String(small.ms)}ms 16G=${String(bomb.ms)}ms  ` +
      `${bomb.code !== 0 && small.code !== 0 && scaled ? '✅ died, and the death point scales with the cap' : '❌ cap did not bind'}\n`,
  );

  const spin = run(['bun', '-e', 'for (;;) {}'], '10');

  process.stdout.write(
    `spin  exit ${String(spin.code)}  ${spin.code === 124 ? '✅ timed out' : '❌ expected 124'}\n`,
  );
  process.exit(bomb.code !== 0 && small.code !== 0 && scaled && spin.code === 124 ? 0 : 1);
}

for (const [key, path] of Object.entries(SRCS)) {
  copyFileSync(path, `${PRISTINE}-${key}.ts`);
}

const restoreAll = () => {
  for (const [key, path] of Object.entries(SRCS)) {
    copyFileSync(`${PRISTINE}-${key}.ts`, path);
  }
};

const survivors = [];
/** Anchors whose occurrence count has drifted — reported TOGETHER (item 1914's harness fix). */
const anchorProblems = [];

try {
  const base = runTests();

  if (!/\d+ pass/.test(base.text) || base.code !== 0) {
    throw new Error(`BASELINE did not pass cleanly:\n${base.text.slice(-900)}`);
  }

  console.log(`baseline: ${/(\d+ pass)/.exec(base.text)?.[1] ?? '?'}\n`);

  for (const [name, which, from, to, want, atRaw] of MUTANTS) {
    // RESTORE BEFORE applying the next mutant, never only after the loop.
    restoreAll();

    const pristine = readFileSync(`${PRISTINE}-${which}.ts`, 'utf8');
    const seen = pristine.split(from).length - 1;

    /*
     * ⚠️⚠️ EVERY ANCHOR MISMATCH IS COLLECTED, NOT THROWN ON THE FIRST. A battery that dies on
     * anchor #1 hides anchors #2..n, so a refactor that moved five of them costs five runs to
     * discover. The run still FAILS; it just reports everything it found first.
     */
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

    console.log(`  ${verdictLabel(caught, expected)}  ${name.padEnd(62)} ${failing}${how}`);
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
