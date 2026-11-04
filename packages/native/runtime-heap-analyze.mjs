/**
 * Aggregate ALLOCATION self size per frame from a `.heapprofile`, then cross-check the same way the
 * CPU screen does.
 *
 * WHY IT EXISTS. Item 1360 screened the write path with a CPU profile and found exactly one unpriced
 * engine frame (`drainMutations`, declined at 1.7%). The biggest single bucket after the top function
 * was `(garbage collector)` at **12.4-20.7% of EVERY write shape** — and a CPU profile can say
 * nothing about it: `(garbage collector)` is a synthesized name with no source location, so it is
 * permanently `n/a` and the screen can never attribute it to the code that produced the garbage. The
 * instrument for that question is the sampling heap profiler, which attributes BYTES to the
 * allocating stack.
 *
 *     node --heap-prof --heap-prof-dir=$D --heap-prof-name=h-<shape>.heapprofile \
 *          --heap-prof-interval=16384 runtime-profile-write-probe.mjs <shape> <reps>
 *     node runtime-heap-analyze.mjs $D
 *
 * ⚠️ READ `selfSize`, NOT the sample COUNT. V8's heap profile is a TREE whose nodes carry aggregated
 * `selfSize` in bytes; the flat `samples` array is the individual sampled allocations and is sparse
 * (84 entries for a 288 ms run at a 16 KB interval). Summing samples would be a much noisier
 * estimate of the same quantity.
 *
 * ⚠️ IT MEASURES BYTES ALLOCATED, NOT GC TIME. Allocating a lot is the usual cause of GC time but the
 * mapping is not linear — short-lived garbage in the nursery is far cheaper per byte than anything
 * that gets promoted. So a big number here LOCATES the pressure; it does not price the fix. Pairing
 * it with the CPU profile's GC share is what makes it actionable.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describeFrame, tagFor, mentions, verdict } from './profile-frames.mjs';

const [, , DIR] = process.argv;

/** Walk the allocation tree, summing `selfSize` per (functionName, file:line). */
const selfBytes = (profilePath) => {
  const prof = JSON.parse(readFileSync(profilePath, 'utf8'));
  const totals = new Map();
  const stack = [prof.head];

  while (stack.length > 0) {
    const node = stack.pop();
    const cf = node.callFrame;
    const name = cf.functionName === '' ? '(anonymous)' : cf.functionName;
    const url = cf.url ?? '';
    // An EMPTY basename, not a nullish one: a native frame carries `url: ''`, so `at(-1)` is `''`
    // and `??` would keep it. Spelled out rather than switched to `??`, which would be wrong.
    const base = url.split('/').at(-1);
    const file = base === undefined || base === '' ? '(native)' : base;
    const line = cf.lineNumber + 1;
    const key = `${name}\u0000${file}:${line}\u0000${url}\u0000${line}`;

    if (node.selfSize > 0) {
      totals.set(key, (totals.get(key) ?? 0) + node.selfSize);
    }

    for (const child of node.children ?? []) {
      stack.push(child);
    }
  }

  return totals;
};

const mib = (bytes) => bytes / (1024 * 1024);

const profiles = readdirSync(DIR)
  .filter((x) => x.endsWith('.heapprofile'))
  .sort();

if (profiles.length === 0) {
  throw new Error(`no .heapprofile in ${DIR} — the run produced nothing to analyze`);
}

for (const f of profiles) {
  const rows = [...selfBytes(join(DIR, f)).entries()]
    .map(([k, bytes]) => {
      const [name, where, url, lineStr] = k.split('\u0000');

      return { ...describeFrame({ name, where, url, line: Number(lineStr) }), value: bytes };
    })
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((a, r) => a + r.value, 0);

  console.log(`\n### ${f}  (${mib(total).toFixed(1)} MiB allocated)`);
  console.log('     MiB   share  mentions  frame');

  for (const r of rows.slice(0, 18)) {
    const share = ((100 * r.value) / total).toFixed(1).padStart(5);
    const shown = r.enclosing === undefined ? r.name : `${r.name} in ${r.enclosing}`;

    console.log(
      `  ${mib(r.value).toFixed(2).padStart(7)}  ${share}%  ${tagFor(mentions(r.checkName))}  ${shown} @ ${r.where}`,
    );
  }

  const { unpriced, unchecked } = verdict(rows.slice(0, 40), total);

  if (unpriced.length === 0) {
    console.log('  (no unpriced allocation site over 2%)');
  } else {
    console.log('  UNPRICED allocation over 2% of the profile:');

    for (const r of unpriced) {
      const via = r.enclosing === undefined ? '' : ` (via enclosing ${r.enclosing})`;

      console.log(`    - ${r.checkName} @ ${r.where}  ${mib(r.value).toFixed(2)} MiB${via}`);
    }
  }

  if (unchecked.length > 0) {
    console.log('  NOT CHECKABLE over 2% — unknown, NOT recorded:');

    for (const r of unchecked) {
      console.log(`    - ${r.name} @ ${r.where}  ${mib(r.value).toFixed(2)} MiB`);
    }
  }
}
