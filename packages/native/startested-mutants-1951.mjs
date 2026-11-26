// Item 1951 — do the new arm's tests have TEETH? A test that passes on its first run and a test
// that checks nothing look identical, so each mutant below is applied to the pristine source, the
// gql suite is run, and the verdict read from a RESULT LINE rather than from an exit code alone.
//
// EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass` / `N fail` to STDERR, so
// stdout and stderr are concatenated and searched for a result line BEFORE the exit code is read —
// items 767 and 772-773 got this wrong in both directions.
//
//     bun startested-mutants-1951.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC = '/home/shawn/projects/pl-graph/packages/gql/src/executor/hop-projection.ts';
// Under `target/`, which is gitignored AND survives the reboot a runaway mutant can force.
const PRISTINE = '/home/shawn/projects/pl-graph/crates/lenke-engine/target/pristine-hop-1951.ts';

copyFileSync(SRC, PRISTINE);

const original = readFileSync(PRISTINE, 'utf8');

/**
 * Each mutant names what it breaks. `expect: 'kill'` means the suite MUST fail; `expect: 'survive'`
 * means it must not, and the reason is recorded — a survivor with a proof is a documented
 * equivalence, a survivor without one is an untested guard.
 */
const MUTANTS = [
  {
    name: 'THE START-LABEL TEST IS GONE, so edges from off-label vertices emit rows',
    expect: 'kill',
    from: `        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {
          continue;
        }

        if (template === undefined) {`,
    to: `        if (template === undefined) {`,
  },
  {
    name: 'THE START TEST READS THE WRONG ENDPOINT (far instead of start)',
    expect: 'kill',
    from: `        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {`,
    to: `        if (!matchesLabel(out ? edge.to : edge.from, startLabel)) {`,
  },
  {
    name: 'THE HOISTED PREDICATE IS INVERTED',
    expect: 'kill',
    from: `      if (!satisfies(far, farPred, binding, params, graph)) {
        continue;
      }

      /*
       * THE ROW IS BUILT ONCE PER FAR VERTEX AND CLONED`,
    to: `      if (satisfies(far, farPred, binding, params, graph)) {
        continue;
      }

      /*
       * THE ROW IS BUILT ONCE PER FAR VERTEX AND CLONED`,
  },
  {
    name: 'THE HOISTED PREDICATE IS DROPPED ENTIRELY',
    expect: 'kill',
    from: `      if (!satisfies(far, farPred, binding, params, graph)) {
        continue;
      }

      /*
       * THE ROW IS BUILT`,
    to: `      /*
       * THE ROW IS BUILT`,
  },
  {
    name: 'THE WALK READS THE FORWARD ADJACENCY, so it is no longer far-driven',
    expect: 'kill',
    from: `      const bucket = (out ? far.adjTo : far.adjFrom)?.get(typeName);

      if (bucket === undefined || bucket.size === 0) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {`,
    to: `      const bucket = (out ? far.adjFrom : far.adjTo)?.get(typeName);

      if (bucket === undefined || bucket.size === 0) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {`,
  },
  {
    name: 'THE FAR-LABEL TEST IS GONE',
    expect: 'kill',
    from: `      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      // ONCE PER FAR VERTEX`,
    to: `      binding.set(farVar, far);

      // ONCE PER FAR VERTEX`,
  },
  {
    name: 'the coverage gate is INVERTED (only selective start labels admitted)',
    // I EXPECTED A KILL AND WAS WRONG, which is the mutation run earning itself in the
    // other direction. Inverting the gate still routes every shape to an answer-EQUIVALENT arm;
    // it is the same class as the boolean mutant below, not a correctness mutant. Recorded with
    // the corrected expectation rather than deleted, so the next reader does not re-expect a kill.
    expect: 'survive',
    why:
      'Answer-equivalent: both arms emit the same multiset, so inverting WHICH one runs is a pure ' +
      'route choice. The 25x it would cost at 1% coverage is item 1938s measurement; the gate ' +
      'arithmetic is unit-tested as `labelCoverage`.',
    from: `    if (coverage === undefined || coverage < EDGE_DRIVEN_MIN_COVERAGE) {
      return filtered(graph, params);
    }

    startTestedWalk ??=`,
    to: `    if (coverage !== undefined && coverage >= EDGE_DRIVEN_MIN_COVERAGE) {
      return filtered(graph, params);
    }

    startTestedWalk ??=`,
  },
  {
    name: 'an UNREADABLE coverage (a compound label) is admitted instead of declining',
    // AN EXPECTED SURVIVOR, AND THE PROOF IS A MEASUREMENT, not a reading of the code. An
    // instrumented build printed which arm each shape takes, and a COMPOUND START LABEL reports
    // `NOT THIS ROUTE` — it never reaches `predicatedHopRoute`'s returned closure at all, because
    // `declinesDisjunction` has already sent every multi-type/disjunctive shape down the
    // start-driven path. So `coverage === undefined` is UNREACHABLE on this route and the test is
    // redundant today. It stays for the reason this file keeps item 444's lesson: a relaxation of
    // the routing above would reopen exactly what it covers, and `labelCoverage` returning
    // `undefined` for every compound kind is unit-tested on its own.
    expect: 'survive',
    why:
      'Unreachable: an instrumented build reports NOT THIS ROUTE for a compound start label, so ' +
      'the undefined-coverage branch cannot be entered. Redundant today, kept as defence in depth.',
    from: `    const coverage = labelCoverage(graph, startLabel);

    if (coverage === undefined || coverage < EDGE_DRIVEN_MIN_COVERAGE) {
      return filtered(graph, params);
    }

    startTestedWalk ??=`,
    to: `    const coverage = labelCoverage(graph, startLabel);

    if (coverage !== undefined && coverage < EDGE_DRIVEN_MIN_COVERAGE) {
      return filtered(graph, params);
    }

    startTestedWalk ??=`,
  },
  {
    name: 'AN ORDER BY no longer forces the start-driven walk',
    expect: 'kill',
    from: `    if (startDrivenForOrder) {
      return filtered(graph, params);
    }

    if (startLabel === undefined || vacuousLabel(graph, startLabel)) {`,
    to: `    if (startLabel === undefined || vacuousLabel(graph, startLabel)) {`,
  },
  {
    name: 'the coverage gate is a BOOLEAN (every non-vacuous start admitted)',
    expect: 'survive',
    why:
      'A ROUTE choice between two answer-equivalent arms. Both emit the same multiset, so no ' +
      'differential test can see it — [[perf-gate-needs-its-own-test]], and the arithmetic is ' +
      'unit-tested as `labelCoverage` in edge-driven-hop-walk.test.ts instead. The 25x this ' +
      'would cost at 1% coverage is item 1938s measurement, not a test.',
    from: `    const coverage = labelCoverage(graph, startLabel);

    if (coverage === undefined || coverage < EDGE_DRIVEN_MIN_COVERAGE) {
      return filtered(graph, params);
    }
`,
    to: '',
  },
  {
    name: 'THE CLONE IS GONE, so every row from one far vertex ALIASES one object',
    expect: 'kill',
    from: `      let template: Row | undefined;

      for (const edge of bucket) {
        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {
          continue;
        }

        if (template === undefined) {
          template = projectRow(proj, binding, params, graph);
          rows.push(template);
          continue;
        }

        rows.push({ ...template });
      }`,
    to: `      let template: Row | undefined;

      for (const edge of bucket) {
        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {
          continue;
        }

        if (template === undefined) {
          template = projectRow(proj, binding, params, graph);
          rows.push(template);
          continue;
        }

        rows.push({ ...template });
      }`.replace('rows.push({ ...template });', 'rows.push(template);'),
  },
  {
    name: 'THE TEMPLATE IS REBUILT PER EDGE (the hoist undone)',
    expect: 'survive',
    why:
      'Answer-equivalent by construction: `!needsStart` means every row a far vertex produces is ' +
      'identical, so rebuilding it per edge yields the same values. This mutant is the PRE arm of ' +
      'item 1952s A/B, which is where it is measured (1.28x) rather than tested.',
    from: `      let template: Row | undefined;

      for (const edge of bucket) {
        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {
          continue;
        }

        if (template === undefined) {
          template = projectRow(proj, binding, params, graph);
          rows.push(template);
          continue;
        }

        rows.push({ ...template });
      }`,
    to: `      for (const edge of bucket) {
        if (!matchesLabel(out ? edge.from : edge.to, startLabel)) {
          continue;
        }

        rows.push(projectRow(proj, binding, params, graph));
      }`,
  },
  {
    name: 'the empty-bucket guard MOVES below the predicate (same set, later skip)',
    expect: 'survive',
    why:
      'This walk has NO template-and-copy fold, so an empty bucket pushes nothing either way — ' +
      'the inner `for` simply does not execute, whichever test skips it. The guard is a cheap ' +
      'early skip, not a correctness condition. Its twin `farDrivenPredicatedHopWalk` DOES need ' +
      'it, because the spread form pushes the template FIRST and would emit one spurious row — ' +
      'so the same line is load-bearing there and redundant here.',
    from: `      if (bucket === undefined || bucket.size === 0) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      // ONCE PER FAR VERTEX, and before the edge loop`,
    to: `      if (bucket === undefined) {
        continue;
      }

      if (farLabel !== undefined && !matchesLabel(far, farLabel)) {
        continue;
      }

      binding.set(farVar, far);

      // ONCE PER FAR VERTEX, and before the edge loop`,
  },
];

const resultLine = /(\d+)\s+pass|(\d+)\s+fail|test result:/;

const runSuite = () => {
  const r = spawnSync('bun', ['test', 'src/'], {
    cwd: '/home/shawn/projects/pl-graph/packages/gql',
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // BOTH streams, then the exit code — never one stream alone.
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const ran = resultLine.test(both);
  const fails = /(\d+)\s+fail/.exec(both);

  return {
    ran,
    failing: fails === null ? 0 : Number(fails[1]),
    status: r.status,
    signal: r.signal,
  };
};

const base = runSuite();

console.log(`baseline: ran=${String(base.ran)} failing=${String(base.failing)}\n`);

if (!base.ran || base.failing !== 0) {
  console.log('BASELINE IS NOT CLEAN — fix that before reading any verdict below.');
  process.exit(1);
}

const survivors = [];

for (const m of MUTANTS) {
  const count = original.split(m.from).length - 1;

  if (count !== 1) {
    console.log(`ANCHOR DRIFT  (${String(count)} matches, expected 1)  ${m.name}`);
    survivors.push(`${m.name} [ANCHOR]`);
    continue;
  }

  writeFileSync(SRC, original.replace(m.from, m.to));

  const r = runSuite();

  // RESTORE BEFORE THE NEXT MUTANT, never only after the loop — an interrupted run must not leave
  // the mutant in the tree.
  copyFileSync(PRISTINE, SRC);

  const killed = r.ran && r.failing > 0;
  const died = r.status === 124 || r.status === 137 || r.signal !== null;
  const verdictOf = () => {
    if (died) {
      return `⏱/💥 non-termination (status ${String(r.status)} signal ${String(r.signal)}) — CAUGHT`;
    }

    // A run that produced NO result line on either stream is not a survivor — it is a harness
    // failure, and conflating the two is exactly what items 767 and 772-773 each got wrong.
    if (!r.ran) {
      return 'DID-NOT-RUN';
    }

    return killed ? `caught   ${String(r.failing)} failing` : 'SURVIVED';
  };
  const verdict = verdictOf();

  const asExpected = m.expect === 'kill' ? killed || died : !killed && !died && r.ran;

  console.log(`${asExpected ? '  ' : ''} ${verdict.padEnd(34)} ${m.name}`);

  if (!asExpected) {
    survivors.push(m.name);
  }
}

copyFileSync(PRISTINE, SRC);
console.log('\n# restored');

if (survivors.length > 0) {
  console.log(`\n${String(survivors.length)} UNEXPECTED:`);

  for (const s of survivors) {
    console.log(`  - ${s}`);
  }
}
