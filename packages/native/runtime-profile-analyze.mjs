/**
 * Aggregate self time per frame from a `.cpuprofile`, then report which frames are UNPRICED —
 * their function name appears nowhere in `CLOSED.md` or the audit.
 *
 * The cross-check is the whole point. Item 919 established that a profiler finds what hand-placed
 * timers cannot, but a profile's top frames are mostly hot for reasons already written down, and
 * re-deriving those is the expensive path CLAUDE.md warns about. A hot frame with ZERO mentions in
 * either store is the one worth a tick.
 *
 * Run it with `runtime-profile-probe.mjs`, which produces one profile per query shape:
 *
 *     for S in control point hopfilter sortedpage grouped; do
 *       node --cpu-prof --cpu-prof-dir=$D --cpu-prof-name=$S.cpuprofile \
 *            runtime-profile-probe.mjs $S 2000
 *     done
 *     node runtime-profile-analyze.mjs $D
 *
 * WHAT IT CANNOT TELL YOU, learned by getting it wrong (item 921): a frame's NAME is not its
 * code. V8 synthesises names for anonymous closures from whatever binding they were assigned
 * through, so `(env) => propOf(env.binding.get(variable), key)` profiles as `variable.variable`
 * and a regex literal profiles as `RegExp: <pattern>`. Those strings can never appear in a
 * document, so "ZERO mentions" says nothing about whether the code is priced — and that closure's
 * path is items 216/224/230's territory, heavily measured. Such names report `n/a`, and so do
 * Node's own loader frames, which are startup cost in someone else's code.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [, , DIR] = process.argv;
const ROOT = new URL('../../', import.meta.url).pathname;

/** Startup cost in Node itself — trivially "unpriced", and it buries the engine frames. */
const NODE_INTERNAL = new Set([
  'compileSourceTextModule',
  'compileForInternalLoader',
  'requireBuiltin',
  'initializeESMLoader',
]);

const docs = ['docs/reviews/CLOSED.md', 'docs/reviews/2026-08-31-ts-audit.md'].map((p) =>
  readFileSync(join(ROOT, p), 'utf8'),
);

/** Self time per (functionName, file:line), summed over samples. */
const selfTime = (profilePath) => {
  const prof = JSON.parse(readFileSync(profilePath, 'utf8'));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const totals = new Map();
  const deltas = prof.timeDeltas ?? [];

  prof.samples.forEach((id, i) => {
    const node = byId.get(id);

    if (node === undefined) {
      return;
    }

    const cf = node.callFrame;
    const name = cf.functionName === '' ? '(anonymous)' : cf.functionName;
    const file = (cf.url ?? '').split('/').at(-1);
    const key = `${name}\u0000${file}:${cf.lineNumber + 1}`;

    totals.set(key, (totals.get(key) ?? 0) + (deltas[i] ?? 0));
  });

  return totals;
};

/** -1 means "not a checkable identifier"; otherwise the mention count across both stores. */
const mentions = (name) => {
  if (name.length < 4 || name.startsWith('(') || name.startsWith('RegExp:')) {
    return -1;
  }

  if (name.includes(' ') || NODE_INTERNAL.has(name)) {
    return -1;
  }

  // `variable.variable` / `name.name` — the giveaway shape of a V8-synthesised closure name.
  const dotted = name.split('.');

  if (dotted.length === 2 && dotted[0] === dotted[1]) {
    return -1;
  }

  return docs.reduce((acc, d) => acc + d.split(name).length - 1, 0);
};

const tagFor = (m) => {
  if (m === -1) {
    return '   n/a';
  }

  return m === 0 ? '  ZERO' : String(m).padStart(6);
};

const profiles = readdirSync(DIR)
  .filter((x) => x.endsWith('.cpuprofile'))
  .sort();

for (const f of profiles) {
  const rows = [...selfTime(join(DIR, f)).entries()]
    .map(([k, us]) => {
      const [name, where] = k.split('\u0000');

      return { name, where, ms: us / 1000 };
    })
    .sort((a, b) => b.ms - a.ms);
  const total = rows.reduce((a, r) => a + r.ms, 0);

  console.log(`\n### ${f}  (${total.toFixed(0)} ms sampled)`);
  console.log('     ms   share  mentions  frame');

  for (const r of rows.slice(0, 22)) {
    const share = ((100 * r.ms) / total).toFixed(1).padStart(5);

    console.log(
      `  ${r.ms.toFixed(1).padStart(7)}  ${share}%  ${tagFor(mentions(r.name))}  ${r.name} @ ${r.where}`,
    );
  }

  const unpriced = rows.slice(0, 40).filter((r) => mentions(r.name) === 0 && r.ms / total > 0.02);

  if (unpriced.length === 0) {
    console.log('  (no unpriced frame over 2% — every hot frame is already recorded)');
  } else {
    console.log('  UNPRICED and over 2% of the profile:');

    for (const r of unpriced) {
      console.log(`    - ${r.name} @ ${r.where}  ${r.ms.toFixed(1)} ms`);
    }
  }
}
