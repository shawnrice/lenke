// Item 1956 — do the count-terminal tests have TEETH? Nine mutants on the rung.
//
// ⚠️ EVIDENCE OF EXECUTION, NOT AN EXIT CODE. `bun test` writes `N pass`/`N fail` to STDERR, so both
// streams are concatenated and searched for a result line BEFORE the exit code is read.
//
//     bun countterm-mutants-1956.mjs
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const SRC =
  '/home/shawn/projects/pl-graph/packages/gremlin/src/executor/edge-filtered-hop-values.ts';
// Under `target/`: gitignored, and it survives the reboot a runaway mutant can force.
const PRISTINE =
  '/home/shawn/projects/pl-graph/crates/lenke-engine/target/pristine-edgefilt-1956.ts';

copyFileSync(SRC, PRISTINE);

const original = readFileSync(PRISTINE, 'utf8');

const MUTANTS = [
  {
    name: '⚠⚠ THE COUNT TERMINAL IS CONSUMED, so the count step is DROPPED from the plan',
    expect: 'kill',
    from: `  return proj.kind === 'count' ? { pick: (far) => far, drops: false, consumed: false } : undefined;`,
    to: `  return proj.kind === 'count' ? { pick: (far) => far, drops: false, consumed: true } : undefined;`,
  },
  {
    name: 'the count terminal sets `drops: true` (no sentinel can ever appear)',
    // ⚠️ I EXPECTED A KILL AND WAS WRONG, and the rung's own header already said why: `drops`
    // only matters when `pick` can return `undefined`. For a count `pick` is `(far) => far`, which
    // returns the element itself and can never be the sentinel, so the flag is unreachable. The
    // file documents the identical equivalence for the bare move and for `id()`. Recorded with the
    // corrected expectation instead of chasing a test that cannot exist.
    expect: 'survive',
    why:
      'Unreachable: `drops` gates a `pick` returning undefined, and `(far) => far` never does. ' +
      'Same equivalence the rung already documents for the bare move and `id()`.',
    from: `  return proj.kind === 'count' ? { pick: (far) => far, drops: false, consumed: false } : undefined;`,
    to: `  return proj.kind === 'count' ? { pick: (far) => far, drops: true, consumed: false } : undefined;`,
  },
  {
    name: '⚠⚠ EVERY terminal is admitted, not just count',
    expect: 'kill',
    from: `  return proj.kind === 'count' ? { pick: (far) => far, drops: false, consumed: false } : undefined;`,
    to: `  return { pick: (far) => far, drops: false, consumed: false };`,
  },
  {
    name: '⚠⚠ THE COUNT TERMINAL IS REFUSED AGAIN (the item undone)',
    // ✅ CAUGHT, and this one is [[perf-gate-needs-its-own-test]] actually working. A route choice
    // is answer-equivalent, so no differential test can see it — but the rung is EXPORTED and the
    // route test asserts `rest.map(kind) === ['count']`, which fails the moment the plan declines.
    // A perf decision made testable by extracting it, rather than left to the A/B alone.
    expect: 'kill',
    from: `  return proj.kind === 'count' ? { pick: (far) => far, drops: false, consumed: false } : undefined;`,
    to: `  return undefined;`,
  },
  {
    name: '⚠⚠ `values(k)` stops being consumed, so the projection runs TWICE',
    expect: 'kill',
    from: `    return { pick: (far) => far.properties[valueKey], drops: true, consumed: true };`,
    to: `    return { pick: (far) => far.properties[valueKey], drops: true, consumed: false };`,
  },
  {
    name: '⚠⚠ `id()` stops being consumed',
    expect: 'kill',
    from: `    return { pick: (far) => far.id, drops: false, consumed: true };`,
    to: `    return { pick: (far) => far.id, drops: false, consumed: false };`,
  },
  {
    name: 'a bare move sets `consumed: true` (there is no step after it to drop)',
    // ⚠️ ALSO NOT A KILL, and the proof is one line of arithmetic: the bare-move branch is
    // reached only when `proj === steps[at + 1]` is `undefined`, i.e. the plan ENDS at the move. So
    // `slice(at + 1)` and `slice(at + 2)` are both empty and the flag cannot change anything. It
    // would matter if a non-projection step could follow the move — but then `proj` is defined and
    // this branch is not taken.
    expect: 'survive',
    why:
      'Unreachable: the branch requires the plan to end at the move, where slice(at+1) and ' +
      'slice(at+2) are both empty.',
    from: `    return { pick: (far) => far, drops: false, consumed: false };
  }

  if (proj.kind === 'id') {`,
    to: `    return { pick: (far) => far, drops: false, consumed: true };
  }

  if (proj.kind === 'id') {`,
  },
  {
    name: '⚠⚠ THE REST SLICE IGNORES `consumed` and always drops one step',
    expect: 'kill',
    from: `    rest: steps.slice(at + 1 + (picked.consumed ? 1 : 0)),`,
    to: `    rest: steps.slice(at + 2),`,
  },
  {
    name: '⚠⚠ THE REST SLICE NEVER drops a step, so a consumed projection runs twice',
    expect: 'kill',
    from: `    rest: steps.slice(at + 1 + (picked.consumed ? 1 : 0)),`,
    to: `    rest: steps.slice(at + 1),`,
  },
];

const resultLine = /(\d+)\s+pass|(\d+)\s+fail|test result:/;

const runSuite = () => {
  const r = spawnSync('bun', ['test', 'src/'], {
    cwd: '/home/shawn/projects/pl-graph/packages/gremlin',
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const both = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const fails = /(\d+)\s+fail/.exec(both);

  return {
    ran: resultLine.test(both),
    failing: fails === null ? 0 : Number(fails[1]),
    status: r.status,
    signal: r.signal,
  };
};

const base = runSuite();

console.log(`baseline: ran=${String(base.ran)} failing=${String(base.failing)}\n`);

if (!base.ran || base.failing !== 0) {
  console.log('⚠️ BASELINE NOT CLEAN');
  process.exit(1);
}

const unexpected = [];

for (const m of MUTANTS) {
  const count = original.split(m.from).length - 1;

  if (count !== 1) {
    console.log(`❌ ANCHOR DRIFT (${String(count)} matches)  ${m.name}`);
    unexpected.push(`${m.name} [ANCHOR]`);
    continue;
  }

  writeFileSync(SRC, original.replace(m.from, m.to));

  const r = runSuite();

  // Restore BEFORE the next mutant, never only after the loop.
  copyFileSync(PRISTINE, SRC);

  const died = r.status === 124 || r.status === 137 || r.signal !== null;
  const killed = r.ran && r.failing > 0;

  const verdictOf = () => {
    if (died) {
      return `⏱/💥 non-termination (status ${String(r.status)}) — CAUGHT`;
    }

    if (!r.ran) {
      return '❌ DID-NOT-RUN';
    }

    return killed ? `✅ caught   ${String(r.failing)} failing` : '❌ SURVIVED';
  };

  const verdict = verdictOf();
  const asExpected = m.expect === 'kill' ? killed || died : !killed && !died && r.ran;

  console.log(`${asExpected ? '  ' : '⚠️'} ${verdict.padEnd(30)} ${m.name}`);

  if (!asExpected) {
    unexpected.push(m.name);
  }
}

copyFileSync(PRISTINE, SRC);
console.log('\n# restored');

if (unexpected.length > 0) {
  console.log(`\n⚠️ ${String(unexpected.length)} UNEXPECTED:`);

  for (const u of unexpected) {
    console.log(`  - ${u}`);
  }
}
