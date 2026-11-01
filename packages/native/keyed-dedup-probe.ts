// The clause-vs-inline keyed-count probe (item 1320). The instrument item 578 prescribed, built,
// and then the one that resolved what item 578's own harness could not.
//
//   PROBE_ROUNDS=1 PROBE_REPS=80 PROBE_DROP=40 bun keyed-dedup-probe.ts <arm>
//
// RUN ONE ARM PER PROCESS, and repeat the PROCESS rather than adding rounds. Rounds inside one
// process warm UNEQUALLY between arms and can invert the comparison's sign: the same pair read
// 2.78x clause-slower with 3 rounds in one process and 2.52x INLINE-slower with 1 round per
// process (item 1320). Arms: clause, inline, inline-where, all-inline, null-a, null-b,
// ctl-clause-bare, ctl-inline-bare, ctl-unseeked.
//
// `null-a` vs `null-b` is the same query under two names — the harness floor. Judge any gap
// against it, because item 578's chase produced a 1.40x headline whose own control was moving
// 2.47x, unread.
//
// Item 578's note on `bench:usage`'s `read: keyed dedup lookup` pair says its own fixture (200
// matches a seek) CANNOT resolve the gap — three runs gave clause 69.3/20.9/69.3k against inline
// 48.1/56.5/15.8k, swings of 3.3x and 3.6x with the direction disagreeing. It prescribes "a
// standalone probe at ~1000 matches a seek to resolve the gap itself", which is this.
//
// What it recorded at that operating point: clause 21.3/20.8/21.8k against inline 11.5/14.4/14.7k,
// a consistent 1.41x, and unresolvable at 20 matches — the signature of a PER-ROW cost. Native
// shows no gap (inline 145.3k vs clause 137.2k), so it is TS-side.
//
// ESTIMATOR per CLAUDE.md's rule for the TS per-row path, because `min` is the WRONG one here: the
// general scalar path plateaus high and emits a rare fast rep, so `min` estimates the two arms
// differently. 14 reps, drop the first three as warm-up, take the MEDIAN of the rest, then the min
// of that across three order-alternated rounds. The per-rep series is printed, because no summary
// of a bimodal series can be trusted without it.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.PROBE_USERS ?? 20_000);
// score = i % BUCKETS, so BUCKETS=20 gives 1000 matches a seek — item 578's operating point.
const BUCKETS = Number(process.env.PROBE_BUCKETS ?? 20);
const REPS = Number(process.env.PROBE_REPS ?? 80);
const DROP = Number(process.env.PROBE_DROP ?? 40);
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
// 80 reps with the first 40 DISCARDED, because the first instrument showed every arm declining
// monotonically across rounds (clause 0.305/0.204/0.167, inline-where 0.380/0.277/0.100) and
// UNEQUALLY between arms — JIT tiering, not a measurement. A min over warming rounds just picks
// the warmest. Dropping half the reps puts the median on the plateau instead.

const graph = new Graph();

for (let i = 0; i < USERS; i++) {
  graph.addVertex({
    id: `u${i}`,
    labels: ['User'],
    // `active` is SELECTIVE, matching item 578's bench fixture (`active: i % 3 === 0`). The
    // first cut set it true for every user, which made the second conjunct VACUOUS — and the
    // pair then read inline 1.39x FASTER with the conjunct and 1.30x SLOWER without it, a
    // direction flip that is incoherent and was the clue. CLAUDE.md's "match the fixture to the
    // claim": a vacuous predicate is a different question from a selective one.
    properties: { score: i % BUCKETS, active: i % 3 === 0, name: `user${i}` },
  });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

const MATCHES = Math.floor(USERS / BUCKETS);

// The fixture asserts its OWN statistics: a probe at the wrong operating point is the whole
// reason item 578's bench row could not resolve this.
const check = query(graph, 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c', { s: 3 });

if (Number(check[0]?.c) !== MATCHES) {
  console.error(`fixture broken: ${String(check[0]?.c)} matches, expected ${MATCHES}`);
  process.exit(3);
}

const ARMS: Record<string, string> = {
  // THE PAIR.
  clause: 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c',
  inline: 'MATCH (u:User {score: $s}) WHERE u.active = true RETURN count(*) AS c',
  'inline-where': 'MATCH (u:User WHERE u.score = $s) WHERE u.active = true RETURN count(*) AS c',

  // CONTROL: no second conjunct. Item 580 narrowed the gap to needing "the MIX of an inline seed
  // and a clause conjunct", so these two must CONVERGE. If they diverge, item 580 is wrong.
  'ctl-clause-bare': 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c',
  'ctl-inline-bare': 'MATCH (u:User {score: $s}) RETURN count(*) AS c',

  // THE DISCRIMINATOR for the shape hypothesis. Both predicates INLINE means ONE CPredicate with
  // props[2] — one `satisfies` call, one object shape. If this is fast, `props` evaluation is
  // fine and the cost is handing the call site two DIFFERENT shapes; if it is slow, the `props`
  // loop itself is the cost. The two loops in `satisfies` are near-identical in body, so the
  // second reading would be the surprising one.
  'all-inline': 'MATCH (u:User {score: $s, active: true}) RETURN count(*) AS c',

  // THE NULL CONTROL, and it is the one thing the earlier chase of this gap left unread. The
  // closed entry records eight readings of this question ranging 0.94x-1.40x, and in the run
  // that produced its headline 1.40x the CLAUSE arm's own rounds were 1.86/4.35/1.76 ms — a
  // 2.47x SELF-ratio, larger than the gap it was the control for. So: the identical clause
  // query under two arm names. Whatever spread this pair shows is this harness's floor, and no
  // gap below it means anything.
  'null-a': 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c',
  'null-b': 'MATCH (u:User) WHERE u.score = $s AND u.active = true RETURN count(*) AS c',

  // CONTROL the change cannot reach: no seekable key at all, so both forms scan.
  'ctl-unseeked': 'MATCH (u:User) WHERE u.active = true RETURN count(*) AS c',
};

const arm = process.argv[2] ?? '';
const src = ARMS[arm];

if (src === undefined) {
  console.log(`arms: ${Object.keys(ARMS).join(' ')}`);
  process.exit(2);
}

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

const rounds: number[] = [];
const shown: string[] = [];
let answer: unknown;

for (let r = 0; r < ROUNDS; r++) {
  const series: number[] = [];

  for (let i = 0; i < REPS; i++) {
    const t = performance.now();
    const out = query(graph, src, { s: i % BUCKETS });

    series.push(performance.now() - t);
    answer = out[0]?.c;
  }

  const warm = series.slice(DROP);

  rounds.push(med(warm));
  shown.push(warm.map((x) => x.toFixed(2)).join(','));
}

console.log(
  `${arm}\t${Math.min(...rounds).toFixed(5)}\t${String(answer)}\t${MATCHES}\t` +
    `rounds=[${rounds.map((x) => x.toFixed(3)).join(',')}]`,
);

// First and last five of the KEPT window, so a residual trend is visible without 40 numbers.
for (const [i, s] of shown.entries()) {
  const xs = s.split(',');

  console.log(`  r${i} head ${xs.slice(0, 5).join(',')} | tail ${xs.slice(-5).join(',')}`);
}
