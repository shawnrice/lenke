import { Graph } from '@lenke/core';

import { parseCacheStats, query } from './src/index.js';

/*
 * Item 2522: does `parse-cache.test.ts`'s "eviction past the cap" test still EVICT?
 *
 * Its comment says "200 distinct texts … The cap is 64, so this evicts several times over", and two
 * comments in that file state the cap as 64. The source says `PARSE_CACHE_CAP = 512`. If the cap was
 * raised after the test was written, 200 texts never reach it and the test — whose describe block is
 * named "eviction past the cap changes no answer" — exercises no eviction at all. It would still
 * pass, because evicting only causes a re-parse: the answers are identical either way, which is
 * exactly why nothing caught it.
 *
 * This replays that loop verbatim and reads the cache's own counters. `size` at the cap means
 * eviction is happening; `size` below it means the loop never gets there.
 *
 * ## WHAT IT ACTUALLY ESTABLISHED, AND THE LIMIT OF WHAT IT CAN SEE
 *
 * It reports 199 against a cap of 512, so the loop does not reach the bound. But the first
 * conclusion drawn from that — "the suite cannot catch unbounded growth" — was WRONG, and this
 * probe is structurally unable to tell: the parse cache is PROCESS-GLOBAL, and in the real suite
 * ~5,666 preceding tests have already filled it. Disabling eviction entirely failed 4 tests in the
 * full gql suite.
 *
 * The fragility was narrower and real: `parse-cache.test.ts` run ALONE passed 18/18 with eviction
 * disabled, because its loop bounds were literals (200, 500) sized when the cap was 64. So the
 * guard's teeth depended on test ORDERING. Item 2522 sized both loops off the reported `cap` and
 * made each block assert the cap is REACHED; the file alone now fails 5 under the same mutant.
 *
 * KEEP THIS PROBE for what it measures honestly — the cache in an ISOLATED process. Do not read a
 * claim about the suite off it.
 */
const g = new Graph();

for (let i = 0; i < 20; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i } });
}

const before = parseCacheStats();

console.log(`# the test's own loop, replayed. cap = ${before.cap}\n`);

/* The test's loop, verbatim: 200 distinct texts, each run TWICE for the admission filter. */
const first = 'MATCH (t:T) WHERE t.k = 0 RETURN count(*) AS c';

query(g, first);

for (let i = 1; i < 200; i += 1) {
  const q = `MATCH (t:T) WHERE t.k = ${i % 20} RETURN count(*) AS c0${i}`;

  query(g, q);
  query(g, q);
}

const after = parseCacheStats();
const cols = [
  `size ${String(after.size).padStart(4)}`,
  `cap ${String(after.cap).padStart(4)}`,
  `seen ${String(after.seen).padStart(4)}`,
];

console.log(`  after 200 distinct texts:  ${cols.join('   ')}`);
console.log(
  after.size >= after.cap
    ? '\n  AT THE CAP — the loop does evict, and the comment is merely stale.'
    : `\n  BELOW THE CAP by ${after.cap - after.size} — the loop NEVER EVICTS. The test named
  "eviction past the cap changes no answer" exercises no eviction; its 200 was sized against a cap
  of 64 and the cap is now ${after.cap}. Answers are identical either way, so nothing failed.`,
);
console.log(`  (cache held ${before.size} entries before this run, from nothing else in-process)`);
