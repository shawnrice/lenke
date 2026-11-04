/**
 * Aggregate self time per frame from a `.cpuprofile`, then report which frames are UNPRICED —
 * their function name appears nowhere in `CLOSED.md` or the audit.
 *
 * The cross-check is the whole point. Item 919 established that a profiler finds what hand-placed
 * timers cannot, but a profile's top frames are mostly hot for reasons already written down, and
 * re-deriving those is the expensive path CLAUDE.md warns about. A hot frame with ZERO mentions in
 * either store is the one worth a tick.
 *
 * Run it with `runtime-profile-probe.mjs` (GQL), `runtime-profile-gremlin-probe.mjs` or
 * `runtime-profile-write-probe.mjs`, each of which produces one profile per shape:
 *
 *     for S in control point hopfilter sortedpage grouped; do
 *       node --cpu-prof --cpu-prof-dir=$D --cpu-prof-name=$S.cpuprofile \
 *            runtime-profile-probe.mjs $S 2000
 *     done
 *     node runtime-profile-analyze.mjs $D
 *
 * The frame cross-checking lives in `profile-frames.mjs`, shared with `runtime-heap-analyze.mjs`;
 * its header records the four defects it has had and why it is one module rather than two copies.
 *
 * ⚠️ SELF TIME IS NOT RELIABLE ATTRIBUTION AT THIS GRANULARITY (item 1104). A small hot callee gets
 * credited with its caller's inlined loop: `edgesOfTypes` read 37.9% / 2765.8 ms self where
 * 3,600,000 calls all took a single-`Map.get` fast path, which would be 768 ns per `Map.get`. Use
 * this screen to NOMINATE, then ablate to price.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describeFrame, isHarnessFrame, mentions, tagFor, verdict } from './profile-frames.mjs';

const [, , DIR] = process.argv;

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
    const url = cf.url ?? '';
    const file = url.split('/').at(-1);
    const line = cf.lineNumber + 1;
    const key = `${name}\u0000${file}:${line}\u0000${url}\u0000${line}`;

    totals.set(key, (totals.get(key) ?? 0) + (deltas[i] ?? 0));
  });

  return totals;
};

const profiles = readdirSync(DIR)
  .filter((x) => x.endsWith('.cpuprofile'))
  .sort();

if (profiles.length === 0) {
  throw new Error(`no .cpuprofile in ${DIR} — the run produced nothing to analyze`);
}

for (const f of profiles) {
  const all = [...selfTime(join(DIR, f)).entries()]
    .map(([k, us]) => {
      const [name, where, url, lineStr] = k.split('\u0000');

      return { ...describeFrame({ name, where, url, line: Number(lineStr) }), value: us / 1000 };
    })
    .sort((a, b) => b.value - a.value);
  // HARNESS FRAMES ARE OUT OF THE DENOMINATOR, not just out of the verdict. Leaving them in makes
  // shares incomparable between runs that use different machinery: item 1362's windowed 200k
  // profiles carried the inspector's own `post` at 15.1-25.5%, which deflated every engine frame by
  // a fifth and made the 20k-vs-200k comparison it existed for unreadable.
  const rows = all.filter((r) => !isHarnessFrame(r.where));
  const harness = all.filter((r) => isHarnessFrame(r.where));
  const total = rows.reduce((a, r) => a + r.value, 0);
  const harnessMs = harness.reduce((a, r) => a + r.value, 0);
  const note =
    harnessMs > 0
      ? `, ${harnessMs.toFixed(0)} ms harness excluded (${harness
          .slice(0, 3)
          .map((r) => r.name)
          .join(', ')})`
      : '';

  console.log(`\n### ${f}  (${total.toFixed(0)} ms engine${note})`);
  console.log('     ms   share  mentions  frame');

  for (const r of rows.slice(0, 22)) {
    const share = ((100 * r.value) / total).toFixed(1).padStart(5);
    const shown = r.enclosing === undefined ? r.name : `${r.name} in ${r.enclosing}`;

    console.log(
      `  ${r.value.toFixed(1).padStart(7)}  ${share}%  ${tagFor(mentions(r.checkName))}  ${shown} @ ${r.where}`,
    );
  }

  const { unpriced, unchecked } = verdict(rows.slice(0, 40), total);

  if (unpriced.length === 0) {
    console.log('  (no unpriced frame over 2%)');
  } else {
    console.log('  UNPRICED and over 2% of the profile:');

    for (const r of unpriced) {
      const via = r.enclosing === undefined ? '' : ` (via enclosing ${r.enclosing})`;

      console.log(`    - ${r.checkName} @ ${r.where}  ${r.value.toFixed(1)} ms${via}`);
    }
  }

  if (unchecked.length > 0) {
    console.log('  NOT CHECKABLE and over 2% — unknown, NOT recorded:');

    for (const r of unchecked) {
      console.log(`    - ${r.name} @ ${r.where}  ${r.value.toFixed(1)} ms`);
    }
  }
}
