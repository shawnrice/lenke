/*
 * Item 2476: PRICE THE MECHANISM BEFORE TOUCHING THE ENGINE.
 *
 * `repeatStep` in packages/gremlin/src/executor/iteration.ts is a BFS BY LEVELS: each level's whole
 * output is collected into `stepped` before the next level runs, so the live set is the WIDEST LEVEL
 * (b^depth). Item 2474 measured that at 37.41 MiB for degree 3 at depth 3 over 20,000 vertices.
 *
 * The candidate fix is a DFS, whose live set is the STACK (depth x b). This micro asks only whether
 * that mechanism holds less, over a plain adjacency array with no engine in the way — the same way
 * item 2456's `length = 0` + `push` question was convicted in one run after two ticks of source
 * reading.
 *
 * Run with --expose-gc. Both arms must EMIT THE SAME MULTISET, asserted here, or the comparison is
 * between two different walks.
 *
 * CONTROLS, both required (a probe with only a target cannot tell a win from a broken instrument):
 *   streaming  — a walk that holds nothing. Must read ~0.
 *   holding    — a walk that holds every emitted row. Must read HIGH.
 * The holding/streaming ratio is a GATE: under 10x the instrument is blind and this exits 1.
 */

const N = Number(process.env.MECH_N ?? 20000);
const DEG = Number(process.env.MECH_DEG ?? 3);
const DEPTH = Number(process.env.MECH_DEPTH ?? 3);
const STEP = Number(process.env.MECH_STEP ?? 4096);
const REPS = Number(process.env.MECH_REPS ?? 3);

if (typeof global.gc !== 'function') {
  console.error('needs --expose-gc');
  process.exit(1);
}

/*
 * Adjacency. The targets are built from the REPEAT INDEX (`d`) as well as `k`, because
 * `to = (k * DEG + d) % N` alone is invariant under k -> k + N and would pile every one of a
 * vertex's out-edges onto the same target (CLAUDE.md's generator trap, items 1516/1518). Asserted
 * below by counting distinct endpoints.
 */
const adj = new Int32Array(N * DEG);

for (let k = 0; k < N; k += 1) {
  for (let d = 0; d < DEG; d += 1) {
    adj[k * DEG + d] = (k * 7919 + d * 104729 + 1) % N;
  }
}

{
  const seen = new Set();

  for (let d = 0; d < DEG; d += 1) {
    seen.add(adj[d]);
  }

  if (seen.size !== DEG) {
    console.error(
      `FIXTURE DEGENERATE: vertex 0's ${DEG} out-edges hit ${seen.size} distinct targets`,
    );
    process.exit(1);
  }
}

/* A traverser, deliberately object-shaped like the engine's so the per-row cost is comparable. */
const mk = (v, loops) => ({ value: v, loops, tags: undefined });

/** BFS BY LEVELS — what `repeatStep` does today. Holds the whole widest level. */
const bfsLevels = function* () {
  let frontier = [];

  for (let k = 0; k < N; k += 1) {
    frontier.push(mk(k, 0));
  }

  for (let i = 0; i < DEPTH && frontier.length > 0; i += 1) {
    const stepped = [];

    for (const t of frontier) {
      for (let d = 0; d < DEG; d += 1) {
        stepped.push(mk(adj[t.value * DEG + d], t.loops + 1));
      }
    }

    frontier = stepped;
  }

  yield* frontier;
};

/** DFS — the candidate. Holds only the stack: DEPTH x DEG. */
const dfs = function* () {
  for (let k = 0; k < N; k += 1) {
    const stack = [mk(k, 0)];

    while (stack.length > 0) {
      const t = stack.pop();

      if (t.loops === DEPTH) {
        yield t;
        continue;
      }

      for (let d = 0; d < DEG; d += 1) {
        stack.push(mk(adj[t.value * DEG + d], t.loops + 1));
      }
    }
  }
};

/** Peak retained during the walk, sampled every STEP rows with a forced collection. */
const peak = (make, hold) => {
  let best = 0;
  let rows = 0;
  let samples = 0;
  const kept = [];

  global.gc();
  const base = process.memoryUsage().heapUsed;

  for (const t of make()) {
    rows += 1;

    if (hold) {
      kept.push(t);
    }

    if (rows % STEP === 0) {
      global.gc();
      const live = process.memoryUsage().heapUsed - base;
      samples += 1;

      if (live > best) {
        best = live;
      }
    }
  }

  // An output too short to reach the sampler would report 0 forever (item 2473).
  return { mib: best / 1048576, rows, samples, keptLen: kept.length };
};

/* Both arms must walk the SAME multiset, or the memory comparison is meaningless. */
const tally = (make) => {
  const counts = new Map();

  for (const t of make()) {
    counts.set(t.value, (counts.get(t.value) ?? 0) + 1);
  }

  return counts;
};

{
  const a = tally(bfsLevels);
  const b = tally(dfs);
  let same = a.size === b.size;

  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      same = false;
      break;
    }
  }

  if (!same) {
    console.error(`ARMS DISAGREE: bfs ${a.size} distinct, dfs ${b.size} — not the same walk`);
    process.exit(1);
  }

  console.log(`  arms emit the same multiset over ${a.size} distinct endpoints`);
}

console.log(`frontier-mech-2476: N=${N} DEG=${DEG} DEPTH=${DEPTH} STEP=${STEP} REPS=${REPS}`);
console.log(`  (expected paths: ${N} * ${DEG}^${DEPTH} = ${N * DEG ** DEPTH})`);
console.log('  arm                              rows   samples     peak MiB');

const arms = [
  ['streaming  [control: holds 0]', () => peak(dfs, false)],
  ['BFS BY LEVELS  (engine today)', () => peak(bfsLevels, false)],
  ['DFS            (candidate)   ', () => peak(dfs, false)],
  ['holding    [control: holds N]', () => peak(dfs, true)],
];
const got = {};

for (const [name, run] of arms) {
  let best = Infinity;
  let last = { rows: 0, samples: 0 };

  for (let r = 0; r < REPS; r += 1) {
    const o = run();

    last = o;

    if (o.mib < best) {
      best = o.mib;
    }
  }

  got[name] = best;
  const cells = [
    name,
    String(last.rows).padStart(9),
    String(last.samples).padStart(7),
    best.toFixed(2).padStart(9),
  ];

  console.log(`  ${cells.join('  ')}`);
}

const hold = got['holding    [control: holds N]'];
const stream = got['streaming  [control: holds 0]'];
const ratio = hold / Math.max(stream, 0.01);

console.log(`\n  holding / streaming = ${ratio.toFixed(1)}x  (must exceed 10x)`);

if (ratio <= 10) {
  console.error('  INSTRUMENT BLIND: a holding walk is not distinguishable from a streaming one.');
  process.exit(1);
}

console.log('  instrument OK: a retaining walk is visible, so a low reading really is low.');
