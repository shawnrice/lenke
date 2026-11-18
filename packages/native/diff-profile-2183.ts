/**
 * THE DIFFERENTIAL PROFILER (item 2183): per-frame self-time of arm A MINUS arm B.
 *
 * ⚠️⚠️ **WHY A SELF-TIME PROFILE OF ONE ARM CANNOT ANSWER "WHAT DOES X ADD?"** Item 2182 chased a ~1.3x
 * penalty for running a bulk add inside a transaction, and profiled the slow arm alone. Every frame it
 * found — `#commitNormalized` 14.9%, `commitElementLabels` 11.3%, GC 21% — appears in BOTH arms, so the
 * ranking says what the WORKLOAD costs and nothing about what the transaction costs. Three hypotheses were
 * eliminated and the question stayed open for want of this instrument.
 *
 * 🔑 Two arms, each in its OWN process (items 2173-2175: in-process timing drifts for dozens of reps and
 * one shape per process is the only reproducible pairing). Per-frame self time is divided by the operation
 * count, so the two columns are per-operation costs and their difference is what the switch ADDS.
 *
 * ```
 *     bun run diff-profile-2183.ts                      # the in-tx vs no-tx bulk add
 *     DIFF_N=50000 bun run diff-profile-2183.ts          # smaller
 *     DIFF_REPS=20 bun run diff-profile-2183.ts
 * ```
 *
 * ⚠️ READ IT AS A RANKING OF DIFFERENCES, NOT AS PROOF. A frame can gain time because the switch calls it
 * more OR because V8 attributed it differently under a different inlining decision — item 2182's
 * `getVertexById` at 19.3% was pure attribution, exactly 1.00 O(1) call per add in both arms. **A nominated
 * frame still needs a call count or a deletion test before it is believed.**
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = Number(process.env.DIFF_N ?? 200_000);
const REPS = Number(process.env.DIFF_REPS ?? 12);

/** The two arms. Each must perform exactly `N * REPS` operations so the columns are comparable. */
const ARMS: ReadonlyArray<readonly [string, string]> = [
  [
    'in-tx',
    `g.transaction(() => { for (let i = 0; i < N; i += 1) { g.addVertex({ id: 'v' + i, labels: ['P'], properties: { k: i % 97 } }); } });`,
  ],
  [
    'no-tx',
    `for (let i = 0; i < N; i += 1) { g.addVertex({ id: 'v' + i, labels: ['P'], properties: { k: i % 97 } }); }`,
  ],
];

type Frame = { readonly name: string; readonly file: string; readonly line: number };

/** Self time per frame, in microseconds, from one `.cpuprofile`. */
const selfTimes = (dir: string): Map<string, { us: number; frame: Frame }> => {
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.cpuprofile'))
    .sort()
    .at(-1);

  if (file === undefined) {
    throw new Error(`no profile written to ${dir}`);
  }

  const prof = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber?: number } }[];
    samples: number[];
    timeDeltas: number[];
  };
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { us: number; frame: Frame }>();

  for (const [i, id] of prof.samples.entries()) {
    const node = byId.get(id);

    if (node === undefined) {
      continue;
    }

    const cf = node.callFrame;
    /*
     * ⚠️ KEYED ON name+file+line, NOT name alone. V8 emits one node per call site, so a helper called
     * from three places is three nodes; collapsing them by name is what makes the two columns comparable
     * when inlining differs between arms.
     */
    const key = `${cf.functionName || '(anon)'}\u0000${cf.url.split('/').pop() ?? ''}\u0000${cf.lineNumber ?? 0}`;
    const prev = out.get(key);
    const dt = Math.max(prof.timeDeltas[i] ?? 0, 0);

    out.set(key, {
      us: (prev?.us ?? 0) + dt,
      frame: {
        name: cf.functionName || '(anon)',
        file: cf.url.split('/').pop() ?? '',
        line: cf.lineNumber ?? 0,
      },
    });
  }

  return out;
};

const run = (label: string, body: string): Map<string, { us: number; frame: Frame }> => {
  const dir = mkdtempSync(join(tmpdir(), `diffprof-${label}-`));
  /*
   * ⚠️⚠️ **THE ARM SCRIPT LIVES IN THIS PACKAGE, NOT IN THE TEMP DIR, AND SETTING `cwd` DOES NOT HELP.**
   * Node resolves bare specifiers from the SCRIPT's directory, so an `arm.mjs` under `/tmp` cannot see
   * `@lenke/core` however the child is launched. 🔑 Only the PROFILE output goes to the temp dir. (Item
   * 2171 lost a profile to this, the note above says so, and I did it again anyway — hence this one.)
   */
  const script = join(new URL('.', import.meta.url).pathname, `arm-${label}-tmp.mjs`);

  writeFileSync(
    script,
    `import { Graph } from '@lenke/core';
const N = ${N};
for (let r = 0; r < ${REPS}; r += 1) {
  const g = new Graph();
  ${body}
}
`,
  );

  /*
   * ⚠️ Run from THIS package so node resolves `@lenke/core` — resolution is relative to the SCRIPT's
   * directory, and a script in a temp dir cannot see the workspace (item 2171 lost a profile to this).
   */
  const res = spawnSync('node', ['--cpu-prof', '--cpu-prof-dir', dir, script], {
    cwd: new URL('.', import.meta.url).pathname,
    encoding: 'utf8',
  });

  rmSync(script, { force: true });

  if (res.status !== 0) {
    throw new Error(`arm ${label} failed: ${(res.stderr ?? '').slice(0, 400)}`);
  }

  return selfTimes(dir);
};

const [[labelA, bodyA], [labelB, bodyB]] = ARMS;
const a = run(labelA, bodyA);
const b = run(labelB, bodyB);
const ops = N * REPS;
const keys = new Set([...a.keys(), ...b.keys()]);
const rows = [...keys]
  .map((k) => {
    const ua = a.get(k)?.us ?? 0;
    const ub = b.get(k)?.us ?? 0;
    const frame = a.get(k)?.frame ?? b.get(k)!.frame;

    return { frame, nsA: (ua * 1000) / ops, nsB: (ub * 1000) / ops };
  })
  .map((r) => ({ ...r, delta: r.nsA - r.nsB }))
  .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

const totalA = [...a.values()].reduce((s, v) => s + v.us, 0) / 1000;
const totalB = [...b.values()].reduce((s, v) => s + v.us, 0) / 1000;

console.log(
  `\n  ${N} ops x ${REPS} reps = ${ops} operations per arm, one process each\n` +
    `  ${labelA} total ${totalA.toFixed(0)} ms   ${labelB} total ${totalB.toFixed(0)} ms   ` +
    `difference ${(totalA - totalB).toFixed(0)} ms  (${(((totalA - totalB) / ops) * 1_000_000).toFixed(1)} ns per op)\n`,
);
console.log(
  `  ${'frame'.padEnd(34)} ${labelA.padStart(9)} ${labelB.padStart(9)} ${'delta ns/op'.padStart(12)}`,
);

for (const r of rows.slice(0, 18)) {
  /* Frames under 1 ns/op either way are noise at this operation count. */
  if (Math.abs(r.delta) < 1 && r.nsA < 1 && r.nsB < 1) {
    continue;
  }

  console.log(
    `  ${`${r.frame.name}:${r.frame.line}`.slice(0, 34).padEnd(34)} ${r.nsA.toFixed(1).padStart(9)} ${r.nsB.toFixed(1).padStart(9)} ${(r.delta > 0 ? `+${r.delta.toFixed(1)}` : r.delta.toFixed(1)).padStart(12)}`,
  );
}

console.log(
  `\n  ⚠️ A RANKING OF DIFFERENCES, NOT PROOF. A frame can gain time because the switch calls it more OR\n` +
    `  because V8 inlined differently — item 2182's getVertexById read 19.3% and was exactly 1.00 O(1)\n` +
    `  call per add in both arms. Confirm a nominated frame with a call count or a deletion test.\n`,
);
