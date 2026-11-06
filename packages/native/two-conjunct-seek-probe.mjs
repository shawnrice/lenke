/**
 * What does a SECOND conjunct cost a seeded count? (item 1604)
 *
 * `bun run bench:usage`'s `read: keyed dedup lookup` is the slowest INDEXED read in the TS engine by
 * 6-20x over its siblings (76.4k ops/s against 468k-1.49M) and the only indexed read row where TS
 * LOSES to native (76.4k against 162.0k). That row's own comment asks for exactly this: "use a
 * standalone probe at ~1000 matches a seek to resolve the gap itself".
 *
 * The cause is structural, read off the planner rather than guessed:
 *
 * ```text
 *    WHERE u.score = $s AND u.active = true     carriers eqProps(2)            specializes FALSE
 *    (u:User {score: $s}) WHERE u.active        carriers props(1) eqProps(1)   specializes FALSE
 *    WHERE u.score = $s                         carriers eqProps(1)            specializes TRUE
 * ```
 *
 * So items 1598/1600's specializer answers the ONE-conjunct shape and refuses both spellings of the
 * two-conjunct one — `specializeSingleProp` takes exactly one entry in exactly one carrier. The
 * single-conjunct row is the control: same seek, same candidates, one predicate fewer.
 *
 * ⚠️ ONE SHAPE PER PROCESS (items 737, 762). `SHAPE=<key>` selects.
 *
 *     SHAPE=two-clause node two-conjunct-seek-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 20_000);
const SHAPE = process.env.SHAPE ?? 'two-clause';
const BUCKETS = Number(process.env.BUCKETS ?? 20);

/**
 * ⚠️ `MULTI=1` GIVES THE FIXTURE A SECOND LABEL, which is the control item 1608 needs. The vacuous-
 * label elision fires only when the queried label covers EVERY vertex, so a single-label fixture —
 * what most of this repo's probes use, including this one by default — measures the best case and a
 * multi-label graph measures nothing at all. Both numbers belong in the entry.
 */
const MULTI = process.env.MULTI === '1';

const TEXT = {
  // The bench row: a seeded equality AND a second equality.
  'two-clause': 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c',
  // Its ISO spelling. Lands in `props` + `eqProps` — TWO carriers, so it refuses for a second
  // reason, and the two must not be allowed to diverge.
  'two-inline': 'MATCH (u:User {score: $s}) WHERE u.active = true RETURN count(*) AS c',
  // THE CONTROL: one conjunct, same seek, already specialized since item 1598.
  'one-clause': 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c',
  'one-inline': 'MATCH (u:User {score: $s}) RETURN count(*) AS c',
  // A second conjunct that is NOT an equality, so it lands in `cmpProps` — a different carrier
  // pair, kept visible so a fix aimed at the equality family is not read as wider than it is.
  'two-mixed': 'MATCH (u:User) WHERE u.score = $s AND u.rank > 1 RETURN count(*) AS c',
  // THREE conjuncts, which no width-2 unroll can answer: the row that says where the next cliff is.
  'three-clause':
    'MATCH (u:User) WHERE u.score = $s AND u.active = true AND u.rank > 1 RETURN count(*) AS c',
}[SHAPE];

if (TEXT === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    // ⚠️ `i % 3`, NOT `i % 2`. `score = i % BUCKETS` with BUCKETS = 20, so a parity-based label
    // CORRELATES with the seek key: every vertex in a given score bucket would share a parity and
    // therefore a label, making each query either all-match or all-reject on the label alone. With
    // `gcd(3, 20) = 1` each bucket holds a MIX, which is what a label test has to be measured over.
    labels: MULTI && i % 3 === 0 ? ['Other'] : ['User'],
    properties: {
      name: `user${i}`,
      score: i % BUCKETS,
      // `active` is true for all but a twentieth, so the second conjunct is NOT the selective one —
      // the seek is. A second conjunct that rejected nearly everything would measure the walk
      // short-circuiting rather than the predicate.
      active: i % 20 !== 0,
      rank: i % 7,
    },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

const paramOf = (i) => ({ s: i % BUCKETS });

for (let i = 0; i < 500; i += 1) {
  query(g, TEXT, paramOf(i));
}

const answer = JSON.stringify(query(g, TEXT, paramOf(1)));
const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  query(g, TEXT, paramOf(i));
}

const ns = ((performance.now() - t0) * 1e6) / REPS;

console.log(
  `${SHAPE.padEnd(14)} ${ns.toFixed(0).padStart(8)} ns/op   answer ${answer}   (${NODES / BUCKETS} candidates a seek)`,
);
