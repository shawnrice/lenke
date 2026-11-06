/**
 * Self-time shares from a V8 `.cpuprofile`, by function.
 *
 * ⚠️ A SELF-TIME SHARE IS A NOMINATION, NOT A PRICE (item 1104). A frame at 30% does not promise
 * 30% back: the work may be irreducible, or moving it may cost more elsewhere. Read this to choose
 * what to MEASURE next, never as the size of a win.
 *
 *     node prof-summary.mjs <dir-or-file> [topN]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [target, topRaw] = process.argv.slice(2);

if (target === undefined) {
  throw new Error('usage: node prof-summary.mjs <dir-or-file> [topN]');
}

const top = Number(topRaw ?? 25);
const path = statSync(target).isDirectory()
  ? join(
      target,
      readdirSync(target).find((f) => f.endsWith('.cpuprofile')) ??
        (() => {
          throw new Error(`no .cpuprofile in ${target}`);
        })(),
    )
  : target;

const prof = JSON.parse(readFileSync(path, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const self = new Map();
const counts = new Map();

// `timeDeltas[i]` is charged to the node of `samples[i]`, which is V8's own accounting.
for (const [i, id] of prof.samples.entries()) {
  const dt = prof.timeDeltas[i] ?? 0;
  const n = byId.get(id);

  if (n === undefined) {
    continue;
  }

  const f = n.callFrame;
  const where = f.url === '' ? '' : `${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  // An explicit test, not `??`: V8 gives an anonymous frame the EMPTY STRING, which `??` does not
  // catch (it only guards null/undefined), so the lint rule's suggested swap would silently label
  // every anonymous frame with a blank name.
  const name = f.functionName === '' ? '(anonymous)' : f.functionName;
  const key = `${name}  ${where}`;

  self.set(key, (self.get(key) ?? 0) + dt);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const total = [...self.values()].reduce((a, b) => a + b, 0);
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);

console.log(
  `total sampled ${(total / 1000).toFixed(1)} ms across ${prof.samples.length} samples\n`,
);

for (const [key, us] of rows) {
  const pct = ((us / total) * 100).toFixed(1);

  console.log(
    `${pct.padStart(5)}%  ${(us / 1000).toFixed(1).padStart(8)}ms  ${String(counts.get(key)).padStart(6)}×  ${key}`,
  );
}
