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
  // ── item 1957: the no-move (edge-valued) surface ──────────────────────────────────────────────
  {
    name: '⚠⚠ THE MOVE IS MANDATORY AGAIN (item 1957 undone)',
    expect: 'kill',
    from: `  const moved = move?.kind === wanted;`,
    to: `  const moved = move?.kind === wanted;

  if (!moved) {
    return undefined;
  }
`,
  },
  {
    name: '⚠⚠ THE MOVE IS TREATED AS ALWAYS PRESENT, so an edge plan projects the far end',
    expect: 'kill',
    from: `  const moved = move?.kind === wanted;`,
    to: `  const moved = true;`,
  },
  {
    name: '⚠⚠ THE MOVE IS NEVER CONSUMED, so a moved plan projects the EDGE',
    expect: 'kill',
    from: `  const moved = move?.kind === wanted;`,
    to: `  const moved = false;`,
  },
  {
    name: '⚠⚠ THE PROJECTION POSITION IGNORES the move, so a moved plan reads the move as its proj',
    expect: 'kill',
    from: `  const projAt = moved ? at + 1 : at;`,
    to: `  const projAt = at;`,
  },
  {
    name: '⚠⚠ THE PROJECTION POSITION ALWAYS SKIPS one, so an edge plan skips its own projection',
    expect: 'kill',
    from: `  const projAt = moved ? at + 1 : at;`,
    to: `  const projAt = at + 1;`,
  },
  {
    name: '⚠⚠ `valuePick` READS THE WRONG ENDPOINT (in place of out)',
    expect: 'kill',
    from: `  return outward ? (edge) => edge.to.properties[key] : (edge) => edge.from.properties[key];`,
    to: `  return outward ? (edge) => edge.from.properties[key] : (edge) => edge.to.properties[key];`,
  },
  {
    name: '⚠⚠ `valuePick` READS THE EDGE even when the plan moved',
    expect: 'kill',
    from: `const valuePick = (key: string, moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge.properties[key];
  }`,
    to: `const valuePick = (key: string, moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved || true) {
    return (edge) => edge.properties[key];
  }`,
  },
  {
    name: '⚠⚠ `elementPick` yields the EDGE even when the plan moved',
    expect: 'kill',
    from: `const elementPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge;
  }`,
    to: `const elementPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved || true) {
    return (edge) => edge;
  }`,
  },
  {
    name: '⚠⚠ `idPick` takes an ENDPOINT id on an edge plan',
    expect: 'kill',
    from: `const idPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (!moved) {
    return (edge) => edge.id;
  }`,
    to: `const idPick = (moved: boolean, outward: boolean): ((edge: Edge) => unknown) => {
  if (moved) {
    return (edge) => edge.id;
  }`,
  },
  {
    name: '⚠⚠ THE COUNT TERMINAL IS CONSUMED, so the count step is DROPPED from the plan',
    expect: 'kill',
    from: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: false }
    : undefined;`,
    to: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: true }
    : undefined;`,
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
    from: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: false }
    : undefined;`,
    to: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: true, consumed: false }
    : undefined;`,
  },
  {
    name: '⚠⚠ EVERY terminal is admitted, not just count',
    expect: 'kill',
    from: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: false }
    : undefined;`,
    to: `  return { pick: elementPick(moved, outward), drops: false, consumed: false };`,
  },
  {
    name: '⚠⚠ THE COUNT TERMINAL IS REFUSED AGAIN (the item undone)',
    // ✅ CAUGHT, and this one is [[perf-gate-needs-its-own-test]] actually working. A route choice
    // is answer-equivalent, so no differential test can see it — but the rung is EXPORTED and the
    // route test asserts `rest.map(kind) === ['count']`, which fails the moment the plan declines.
    // A perf decision made testable by extracting it, rather than left to the A/B alone.
    expect: 'kill',
    from: `  return proj.kind === 'count'
    ? { pick: elementPick(moved, outward), drops: false, consumed: false }
    : undefined;`,
    to: `  return undefined;`,
  },
  {
    name: '⚠⚠ `values(k)` stops being consumed, so the projection runs TWICE',
    expect: 'kill',
    from: `    return { pick: valuePick(valueKey, moved, outward), drops: true, consumed: true };`,
    to: `    return { pick: valuePick(valueKey, moved, outward), drops: true, consumed: false };`,
  },
  {
    name: '⚠⚠ `id()` stops being consumed',
    expect: 'kill',
    from: `    return { pick: idPick(moved, outward), drops: false, consumed: true };`,
    to: `    return { pick: idPick(moved, outward), drops: false, consumed: false };`,
  },
  {
    name: 'a bare move sets `consumed: true` (there is no step after it to drop)',
    // ⚠️ ALSO NOT A KILL, and the proof is one line of arithmetic. The branch is reached only
    // when `proj === steps[projAt]` is `undefined`, i.e. the plan ENDS — at the move if it moved,
    // after the `has` run if it did not (item 1957 added the second case and the proof survives it
    // unchanged). Either way `slice(projAt)` and `slice(projAt + 1)` are both empty, so the flag
    // cannot change anything. It would matter if a non-projection step could sit there — but then
    // `proj` is defined and this branch is not taken.
    expect: 'survive',
    why:
      'Unreachable: the branch requires the plan to END at projAt, where slice(projAt) and ' +
      'slice(projAt + 1) are both empty — true for a moved plan and for an edge plan alike.',
    from: `  if (proj === undefined) {
    return { pick: elementPick(moved, outward), drops: false, consumed: false };
  }`,
    to: `  if (proj === undefined) {
    return { pick: elementPick(moved, outward), drops: false, consumed: true };
  }`,
  },
  {
    name: '⚠⚠ THE REST SLICE IGNORES `consumed` and always drops one step',
    expect: 'kill',
    from: `    rest: steps.slice(projAt + (picked.consumed ? 1 : 0)),`,
    to: `    rest: steps.slice(projAt + 1),`,
  },
  {
    name: '⚠⚠ THE REST SLICE NEVER drops a step, so a consumed projection runs twice',
    expect: 'kill',
    from: `    rest: steps.slice(projAt + (picked.consumed ? 1 : 0)),`,
    to: `    rest: steps.slice(projAt),`,
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
