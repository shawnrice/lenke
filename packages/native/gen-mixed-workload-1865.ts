/**
 * Emits the mixed workload's query list for `mixed-workload-prof-1865.mjs` — item 1865.
 *
 * IT EXISTS SO THE GENERATORS ARE NOT FORKED. The profiler runs under node (`--cpu-prof`) and
 * node will not resolve `./src/workload-queries.js` to its `.ts` source; bun will. So bun draws
 * the queries here, from the SAME `WORKLOAD_FAMILIES` the screen uses, and writes them out.
 *
 * `multi-pattern` IS SKIPPED BY DEFAULT: it is 97% of the screen's wall time and item 1864
 * closed it as not addressable, so profiling with it in returns its binding loop and nothing else.
 */
import { writeFileSync } from 'node:fs';

import { WORKLOAD_FAMILIES } from './src/workload-queries.js';

const QUERIES = Number(process.env.QUERIES ?? 40);
const SEED = Number(process.env.SEED ?? 20_261_114); // the screen's default
const SKIP = (process.env.SKIP ?? 'multi-pattern').split(',');
const OUT = process.env.WORK_FILE ?? './mixed-workload-1865.json';

/**
 * THE NAME COMES FROM THE GENERATOR, NOT FROM `WORKLOAD_FAMILY_NAMES[i]`, AND THE FIRST
 * VERSION OF THIS FILE GOT THAT WRONG IN A WAY THAT INVALIDATED A WHOLE PROFILE.
 *
 * `WORKLOAD_FAMILY_NAMES` is `.sort()`ed; `WORKLOAD_FAMILIES` is in declaration order. The two are
 * NOT index-aligned, so `NAMES[i]` does not name `FAMILIES[i]` — sorted index 12 is `range-scan`
 * while `FAMILIES[12]` is `multiPattern`. Pairing them by index therefore mislabelled every family
 * AND made `SKIP=multi-pattern` drop `aggregate` instead, so the profile was 97% multi-pattern:
 * precisely the family the exclusion existed to remove, and one item 1864 had already closed as
 * not addressable. A family's name is a constant within its generator, which is how
 * `WORKLOAD_FAMILY_NAMES` derives itself — so ask the generator.
 */
const nameOf = (gen: (r: () => number) => { family: string }): string => gen(() => 0).family;

const rng = (seed: number): (() => number) => {
  let t = seed >>> 0;

  return () => {
    t += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const work: unknown[] = [];

for (const gen of WORKLOAD_FAMILIES) {
  const name = nameOf(gen);

  if (SKIP.includes(name)) {
    continue;
  }

  // THE SCREEN'S OWN PER-FAMILY SEEDING, copied rather than invented: `SEED ^ (name.length *
  // 2_654_435_761)`. The first version used `SEED + i * 7919` with a different default SEED, so it
  // drew a different workload from the screen it claims to profile — which is how an instrument
  // ends up measuring something its header does not describe.
  const r = rng(SEED ^ (name.length * 2_654_435_761));

  for (let q = 0; q < QUERIES; q += 1) {
    work.push({ name, ...gen(r) });
  }
}

writeFileSync(OUT, JSON.stringify(work));
console.log(`wrote ${String(work.length)} queries to ${OUT}`);
