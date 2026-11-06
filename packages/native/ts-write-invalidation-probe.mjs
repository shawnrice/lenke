/**
 * Does a single write DEMOTE later reads in the TS engine, and for how long? (item 1580)
 *
 * CLAUDE.md records the shape of this on the RUST side and is emphatic about it: `rebuild_csr` runs
 * only at LOAD, every adjacency write clears `csr_fresh`, and **nothing re-arms it** — so one
 * `add_edge` demotes EVERY later read for the rest of the session, by a factor proportional to how
 * selective the queried edge type is (1.96x at 1 edge in 2, 24.07x at 1 in 50).
 *
 * The TS engine has no counterpart measured either way. The question decomposes into three arms, and
 * which pair matches tells you which world you are in:
 *
 *     reads        N reads, no writes at all                     the baseline
 *     interleaved  N x (one write, then one read)                the serving pattern
 *     afterone     ONE write, then N reads                       <- the diagnostic
 *
 *   afterone ~= reads        a write costs only the write; caches re-arm
 *   afterone ~= interleaved  ONE write demotes everything after it — the Rust engine's bug
 *
 * ⚠️ ONE ARM PER PROCESS (`ARM=<name>`). Items 1578 and 1579 each produced an IMPOSSIBLE in-process
 * reading — a negative build share, then a fixed lookup slower than a random one — because several
 * arms shared a call site and whichever ran first paid. Position beat effect both times.
 *
 *     for a in reads interleaved afterone writes; do ARM=$a node ts-write-invalidation-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { V, count, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 200);
const ARM = process.env.ARM ?? 'reads';
/**
 * How selective the queried edge type is. The Rust penalty scaled with exactly this — a stale CSR
 * walks every edge and filters, so a rarer type pays more — which is why it is a knob and not a
 * constant.
 */
const RARE = Number(process.env.RARE ?? 10);

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

// Split the target on the REPEAT INDEX: `(i * a + b) % N` is invariant under `i -> i + N`, so a flat
// loop would point all of one vertex's edges at the same target and leave the graph functional.
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      // One edge in `RARE` carries `T`; the rest carry `E`.
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: [(rep * NODES + i) % RARE === 0 ? 'T' : 'E'],
    });
  }
}

// The read under test: a typed hop count over the RARE type, which is the shape the Rust penalty
// scaled with.
const plan = traversal(V(), out('T'), count());
let extra = 0;
const read = () => {
  const rows = toArray(plan, g);

  return Array.isArray(rows) ? Number(rows[0]) : 0;
};
const write = () => {
  extra += 1;
  g.addEdge({
    id: `x${extra}`,
    from: vs[extra % NODES],
    to: vs[(extra * 13 + 1) % NODES],
    labels: ['E'],
  });
};

// ⚠️ A SECOND READ THAT CANNOT SHORTCUT. `V().out(T).count()` is answered in CLOSED FORM off degree
// sums — the first run of this probe showed 200 reads in 0.1 ms, which is not a walk — so it tests
// the count rung and says nothing about the walking path the Rust CSR penalty lives on. This one
// materializes a value per edge and has to walk.
const walkPlan = traversal(V(), out('T'), values('k'));
const readWalk = () => {
  const rows = toArray(walkPlan, g);

  return Array.isArray(rows) ? rows.length : 0;
};

const ARMS = {
  reads: () => {
    for (let i = 0; i < REPS; i += 1) {
      read();
    }
  },
  interleaved: () => {
    for (let i = 0; i < REPS; i += 1) {
      write();
      read();
    }
  },
  afterone: () => {
    write();

    for (let i = 0; i < REPS; i += 1) {
      read();
    }
  },
  /** The writes alone, so the interleaved arm can be charged for them. */
  writes: () => {
    for (let i = 0; i < REPS; i += 1) {
      write();
    }
  },
  // The same three questions for the WALKING read.
  readswalk: () => {
    for (let i = 0; i < REPS; i += 1) {
      readWalk();
    }
  },
  interleavedwalk: () => {
    for (let i = 0; i < REPS; i += 1) {
      write();
      readWalk();
    }
  },
  afteronewalk: () => {
    write();

    for (let i = 0; i < REPS; i += 1) {
      readWalk();
    }
  },
};

const run = ARMS[ARM];

if (run === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

// One warm-up pass, then timed rounds. A fresh graph per round is not possible here — the whole
// point is cumulative write state — so the rounds are reported in full and the LAST is the one to
// read when an arm is expected to degrade.
read();

const rounds = [];

for (let q = 0; q < 5; q += 1) {
  const t0 = performance.now();

  run();
  rounds.push(Number((performance.now() - t0).toFixed(1)));
}

console.log(
  JSON.stringify({
    arm: ARM,
    reps: REPS,
    rare: RARE,
    answer: read(),
    msPerRound: rounds,
    usPerRead: Number((((rounds[rounds.length - 1] ?? 0) / REPS) * 1000).toFixed(1)),
  }),
);
