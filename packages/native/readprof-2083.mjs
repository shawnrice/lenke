/*
 * Self-time aggregation over a V8 `.cpuprofile` — frames, not guesses (item 2083).
 *
 * TWO THINGS THAT MADE THE FIRST FOUR PROFILES WORTHLESS, both the caller's fault rather than
 * this reader's, and both worth stating here because this is the file you reach for next time:
 *
 *   1. `runtime-profile-probe.mjs` TAKES ITS SHAPE FROM `argv[2]`, NOT from a `SHAPE=` env var. Three
 *      "different" shapes all profiled `hopfilter`, and the only tell was the `"shape"` field in the
 *      probe's own one-line output. READ IT BACK before trusting a profile.
 *   2. THE FIXTURE BUILD IS IN THE SAMPLES. At 30 reps over 50,000 vertices, `indexEdgeLabel`,
 *      `commitElementLabels`, `#commitNormalized` and the probe's own `build` were a THIRD of the
 *      profile, and `getVertexById` — which looks like a query frame — is mostly edge wiring. At 600
 *      reps the build drops under 2%. If a construction frame is visible at all, the rep count is too
 *      low to read anything else.
 *
 * Usage: node readprof-2083.mjs <dir containing one .cpuprofile>   [TOP=n]
 */
import { readdirSync, readFileSync } from 'node:fs';

const [, , dir] = process.argv;

if (dir === undefined) {
  throw new Error('usage: node readprof-2083.mjs <profile dir> (TOP=n to change the row count)');
}

const [file] = readdirSync(dir).filter((x) => x.endsWith('.cpuprofile'));

if (file === undefined) {
  throw new Error(`no .cpuprofile in ${dir}`);
}

const profile = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const total = profile.timeDeltas.reduce((a, b) => a + Math.max(0, b), 0);

for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);

  if (node === undefined) {
    continue;
  }

  const frame = node.callFrame;
  const where = `${(frame.url ?? '').split('/').slice(-1)[0]}:${frame.lineNumber + 1}`;
  // AN EMPTY STRING, NOT NULL, is how V8 names an anonymous frame — so `??` would keep it and
  // every anonymous frame would collapse into one blank row. The explicit length test is the point.
  const name = frame.functionName.length > 0 ? frame.functionName : '(anon)';
  const key = `${name} @ ${where}`;

  self.set(key, (self.get(key) ?? 0) + Math.max(0, profile.timeDeltas[i] ?? 0));
}

const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 14));

console.log(`total ${(total / 1000).toFixed(1)} ms`);

for (const [key, us] of rows) {
  const pct = ((us / total) * 100).toFixed(1).padStart(5);

  console.log(`  ${pct}%  ${(us / 1000).toFixed(1).padStart(7)} ms  ${key}`);
}
