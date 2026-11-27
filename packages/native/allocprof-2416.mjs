/**
 * WHO ALLOCATES, AND WHAT SURVIVES? The allocation profiler this directory does not have - in two
 * mechanisms, each calibrated against a quantity that is actually known.
 *
 * WHAT WAS MISSING. 37 probes here drive `node:inspector`'s CPU profiler and ZERO drive its HEAP
 * profiler, so every allocation question so far has been answered INDIRECTLY: by a GC percentage
 * (`gc-cost-probe.mjs`) or by a CPU frame that happens to be an allocation site.
 * [[binding-allocation-is-closed]] priced the matcher's per-row `Map` at 28.5% self plus 24% GC from
 * exactly that indirect reading, and neither instrument can say WHICH frame's bytes those were or
 * how many bytes one query costs.
 *
 * ## ITEM 1361's VERDICT IS TOO STRONG, AND THIS PROBE NARROWS IT
 *
 * `PROBES.md` records `node --heap-prof` as *"the only instrument in this directory found wholly
 * unfit rather than subtly biased"* - 0.7 MiB reported for 128 MiB allocated, the allocating
 * function never named, identically in a retained and a garbage arm. Driven as the INSPECTOR DOMAIN
 * around a bounded in-process window rather than through the CLI wrapper, it splits cleanly:
 *
 *     2,097,152 small objects through one site      reported        actually live
 *       RETAINED in an array                     134.6 MiB            149.1 MiB heapUsed
 *       dropped immediately (nursery garbage)       3.9 KiB           ~134.6 MiB allocated
 *
 * So it is **SOUND FOR RETAINED BYTES AND BLIND TO CHURN** - which is the diagnosis `PROBES.md`
 * itself anticipated: *"If retained shows up and garbage does not, the profiler is reporting LIVE
 * bytes rather than allocated bytes."* That makes it a usable instrument for a question nothing here
 * could ask before - **which frame's allocations SURVIVE** - and not a usable one for GC churn.
 * The CLI wrapper's extra defect (it dumps at process exit, after collections) is what made both
 * arms look equally dead.
 *
 * ## AND THE OLD CALIBRATION'S REFERENCE WAS NOT A KNOWN QUANTITY
 *
 * Item 1361's arms allocate "~128 MiB" as `COUNT * 64` bytes, where 64 is an ASSUMED V8 size for
 * `{a, b, c, d}`. Measured here, it is **67.3 B** - so the true figure is ~134.6 MiB and anything
 * calibrated against 128 is off by 5% before it starts. More importantly a churn meter was then
 * judged against a number nobody had verified.
 *
 * **SO THE CHURN ARM CALIBRATES ON LINEARITY INSTEAD**, which needs no knowledge of V8's object
 * layout: allocate 1x, 2x and 4x the same objects and a sound meter must report ratios near 1:2:4.
 * A reference you can derive from the instrument's own output is the only kind worth having.
 *
 * ## THE CHURN METER KNOWS WHEN IT IS LYING
 *
 * `heapUsed` after minus before IS the bytes allocated - but only while no collection runs inside
 * the window, because a scavenge returns part of them and the delta then UNDER-reports, which is the
 * failure mode that looks like a win. The garbage arm measured 61.7 MiB against ~134.6 allocated for
 * exactly that reason. So every window is watched with a `PerformanceObserver` on `gc` and any
 * reading with a collection in it is printed as a LOWER BOUND, never as a figure.
 *
 * **DRAIN THE OBSERVER BEFORE READING IT** - entries arrive in a queued callback, so a synchronous
 * rep loop buffers every one and `disconnect()` fires first. That cost item 1361 a reported "0
 * pauses, 0.0% GC" on a run that was really at 18.6%, and it is why the await below is not optional.
 *
 *     node --expose-gc allocprof-2416.mjs                          # calibrate churn (linearity)
 *     MECH=retained node --expose-gc allocprof-2416.mjs            # calibrate retention (2 arms)
 *     SHAPE=hop2generic node --expose-gc allocprof-2416.mjs        # bytes per row, per query
 *     SHAPE=hop2generic MECH=retained node --expose-gc allocprof-2416.mjs   # which frame SURVIVES
 */
import { Session } from 'node:inspector';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const MECH = process.env.MECH ?? 'churn';
const SHAPE = process.env.SHAPE ?? 'cal';
const NODES = Number(process.env.NODES ?? 50_000);
const REPS = Number(process.env.REPS ?? 5);

const MIB = 1024 * 1024;

/**
 * A module-level sink, so the garbage arm's objects genuinely ESCAPE and are genuinely allocated.
 *
 * THE NAIVE GARBAGE ARM ALLOCATES NOTHING, AND THAT IS A REAL TRAP RATHER THAN A DETAIL. Item
 * 1361's arm is `const obj = {...}; sink += obj.a;` - the object never escapes the iteration, so
 * once TurboFan optimizes the loop V8's ESCAPE ANALYSIS scalar-replaces it and no allocation
 * happens at all. Measured: churn per object falls **51.3 -> 66.8 -> 46.4 -> 29.7 B** as the count
 * grows 1x to 8x, which is the optimizer catching up mid-loop, with two independent accounting
 * routes agreeing throughout. A meter cannot be calibrated against an allocation the compiler
 * removed.
 *
 * So each object is stored into a slot of a fixed-size module-level array: it escapes (so it is
 * really allocated and really 67 B), and 1,023 of every 1,024 are overwritten immediately (so they
 * are really garbage). That is churn an optimizer cannot remove.
 *
 * ITEM 1361'S VERDICT IS THEREFORE DOUBLY QUALIFIED: its garbage arm may have been reporting ~0
 * because ~0 was allocated, which is the instrument being right. Its RETAINED arm reporting the
 * same ~0.7 MiB is the actual defect, and it is in the CLI wrapper - the same domain driven
 * in-process reports 183.3 MiB for that arm here.
 */
const SINK = new Array(1024).fill(null);

/** The ONE named allocation site, so a per-frame instrument has something to attribute to. */
const burn = (count, keep) => {
  const held = keep ? [] : undefined;

  for (let i = 0; i < count; i += 1) {
    const obj = { a: i, b: i + 1, c: `s${i & 1023}`, d: null };

    if (keep) {
      held.push(obj);
    } else {
      SINK[i & 1023] = obj;
    }
  }

  return keep ? held : SINK.length;
};

/**
 * Bytes allocated inside `fn`, accounted ACROSS the collections rather than around them.
 *
 * WHY THE OBVIOUS VERSION CANNOT WORK, measured rather than assumed. `heapUsed` after minus before
 * is the bytes allocated only while no collection runs in the window, and in this runtime one
 * always does: `new_space` starts at **1 MiB** and V8 grows it adaptively, so a 4 MiB window takes
 * several scavenges and `--max-semi-space-size` does not prevent them. The delta then under-reports
 * by 4-5x (65,536 objects of 67.3 B read as 13-30 B/object), which is the failure mode that looks
 * like a win. A first version also counted its OWN `global.gc()` calls as collections in the window
 * and so reported 1/4/13 collections IDENTICALLY at three semi-space sizes - a GC count that does
 * not respond to the knob controlling GC is the instrument measuring itself.
 *
 * SO THE COLLECTIONS ARE ACCOUNTED FOR INSTEAD OF AVOIDED. `v8.GCProfiler` reports `usedHeapSize`
 * BEFORE and AFTER every collection in the window, and between two collections the heap only grows
 * by what was allocated:
 *
 *     churn = SUM over collections of (usedBefore_i - usedAfter_{i-1})  +  (usedEnd - usedAfter_n)
 *
 * with `usedAfter_0` the baseline. That is exact whatever the GC does, which is what makes it
 * calibrate linearly where the delta does not.
 */
const byChurn = async (fn) => {
  if (typeof global.gc !== 'function') {
    throw new Error('this probe needs --expose-gc: without a settled baseline the delta is noise');
  }

  global.gc();

  const profiler = new v8.GCProfiler();

  profiler.start();

  const before = process.memoryUsage().heapUsed;
  const out = fn();
  const end = process.memoryUsage().heapUsed;
  const result = profiler.stop();

  const stats = result.statistics ?? [];
  let churn = 0;
  let prevAfter = before;
  // The SECOND estimate: every scavenge fires at a full nursery, so the `new_space` bytes it found
  // in use are bytes that were allocated since the previous one.
  let newSpaceTotal = 0;

  for (const ev of stats) {
    const b = ev.beforeGC?.heapStatistics?.usedHeapSize;
    const a = ev.afterGC?.heapStatistics?.usedHeapSize;

    if (typeof b !== 'number' || typeof a !== 'number') {
      continue;
    }

    // A collection can only shrink the heap, so a negative growth is a baseline we mis-paired
    // rather than negative allocation — clamp instead of silently subtracting.
    churn += Math.max(0, b - prevAfter);
    prevAfter = a;

    const ns = ev.beforeGC?.heapSpaceStatistics?.find((x) => x.spaceName === 'new_space');

    newSpaceTotal += ns?.spaceUsedSize ?? 0;
  }

  churn += Math.max(0, end - prevAfter);

  global.gc();

  return {
    out,
    churn,
    retained: process.memoryUsage().heapUsed - before,
    gc: { count: stats.length, pauseMs: 0 },
    newSpaceTotal,
  };
};

/** Per-frame SURVIVING bytes, from the sampling heap profiler driven around the window. */
const byRetained = async (fn) => {
  const session = new Session();

  session.connect();

  const post = (method, params) =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
    });

  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 1024 });

  const out = fn();
  const { profile } = await post('HeapProfiler.stopSampling');

  await post('HeapProfiler.disable');
  session.disconnect();

  const self = new Map();
  let total = 0;

  const walk = (node) => {
    const { functionName, url, lineNumber } = node.callFrame;
    const name = functionName === '' ? '(anonymous)' : functionName;
    const file = String(url).split('/').pop();
    const where = `${name}  ${file === '' ? '(native)' : file}:${String(lineNumber)}`;

    if (node.selfSize > 0) {
      self.set(where, (self.get(where) ?? 0) + node.selfSize);
    }

    total += node.selfSize;

    for (const c of node.children ?? []) {
      walk(c);
    }
  };

  walk(profile.head);

  return { out, total, self };
};

/**
 * WHAT THE BYTES COST IN TIME - the other half of an allocation profiler, and the reason this probe
 * does not hand anyone a byte count on its own.
 *
 * A churn figure is not a prize. V8's nursery is cheap and a shape can allocate 1.5x another while
 * running no slower, so "this query allocates 5.79 MiB" licenses nothing until the GC share of its
 * runtime is known. This arm times the shape and attributes the collector's pauses to it, which
 * BOUNDS what removing the allocation could ever return.
 *
 * `gc-cost-probe.mjs` is the precedent and the cross-check: it put the write path at 17.6% GC
 * against a CPU profile's 18.6% for the same shape, which is what makes either readable.
 */
const byGcShare = async (fn, reps) => {
  /*
   * THE `gc` HOOK MUST BE GIVEN A MACROTASK TO INSTALL, BEFORE the window - and this is the half
   * of the rule `PROBES.md` does not have.
   *
   * Measured: the FIRST `PerformanceObserver` on `gc` in a process delivers NOTHING across 14 reps,
   * while a second and third in the same process deliver 5 and 2. With one `await` placed between
   * `observe()` and the window the first one delivers 3. So entries emitted before the hook is
   * installed are dropped on the floor, silently.
   *
   * `PROBES.md` records only the DRAIN hazard - entries arrive in a queued callback, so a
   * synchronous rep loop buffers every one and `disconnect()` fires first, which cost item 1361 a
   * reported "0 pauses and 0.0% GC" on a run really at 18.6%. That is real and necessary. It is
   * also not sufficient: this probe drained correctly and still read 0.0% for a shape churning
   * ~875 MiB per rep. `gcobs-check-2416.mjs` is the five-line calibration, and the self-check below
   * is what turns a silent zero into a failure.
   *
   * NOT the GC profiler: an immediate `GCProfiler` start/stop does not arm them, and neither does
   * one with a real collection inside it. Both were tried and the self-check still fired.
   */
  let pauseMs = 0;
  let count = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      pauseMs += e.duration;
      count += 1;
    }
  });

  obs.observe({ entryTypes: ['gc'] });

  await new Promise((r) => setTimeout(r, 0));

  /*
   * A FORCED COLLECTION THE OBSERVER MUST SEE, so a reported 0.0% is distinguishable from a dead
   * observer. The arm's first version printed "0 collections" for a shape churning ~875 MiB per
   * rep, which is not a believable zero - and `gcobs-check-2416.mjs` shows the same five lines
   * delivering 93 collections in a standalone process, so the hazard is live in THIS process and
   * not in the API. Item 1361 lost a reading to exactly this and `PROBES.md` warns about the drain;
   * the warning is necessary and, on its own, not sufficient.
   */
  const probe = count;

  global.gc();

  /*
   * THE FORCED COLLECTION IS DELIVERED AND THEN DISCOUNTED, because charging it to the window
   * makes the share meaningless. `global.gc()` on a heap holding a 200,000-vertex graph is a full
   * mark-compact: the first version read **112.5 ms of pause inside a ~75 ms window - 67% of a
   * time it exceeds**, which is the arithmetic saying so out loud. The forced collection's own
   * entry is what proves the observer alive, so it is awaited, counted, and then subtracted.
   */
  await new Promise((r) => setTimeout(r, 0));

  if (count === probe) {
    throw new Error(
      'the gc observer saw not even the collection this arm forced — it is dead in this process, ' +
        'and a 0.0% GC share from it would be a lie (see gcobs-check-2416.mjs)',
    );
  }

  const basePause = pauseMs;
  const baseCount = count;
  const series = [];

  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  // The queued callback must run before the counters are read - item 1361's 0.0%-GC defect.
  await new Promise((r) => setTimeout(r, 0));
  obs.disconnect();

  // The first three reps are the JIT tiering up and are dropped from the TIME, but their
  // collections are already in `pauseMs`, so the share is computed over the whole run.
  const kept = series.slice(3).sort((a, b) => a - b);
  const total = series.reduce((a, b) => a + b, 0);

  const windowPause = pauseMs - basePause;

  return {
    median: kept[kept.length >> 1],
    series,
    pauseMs: windowPause,
    count: count - baseCount,
    share: total === 0 ? 0 : (windowPause / total) * 100,
  };
};

const buildGraph = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
  }

  for (let e = 0; e < NODES; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${e}`),
      to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The one-hop family item 2415 left open, asked about BYTES rather than milliseconds.
  hop1: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k',
  hop1sum: 'MATCH (a:P)-[:E]->(x1:P) RETURN sum(x1.k) AS s',
  // THE BISECTION of the folds' per-element allocation. `count(*)` needs no per-element READ and
  // churns ~0; `count(x1.k)` needs the read but no arithmetic; `max` reads and compares; `sum`
  // reads and adds. Whichever step the bytes appear at is the one allocating.
  hop1countk: 'MATCH (a:P)-[:E]->(x1:P) RETURN count(x1.k) AS c',
  // WALKS BUT READS NO PROPERTY - the control that separates the walk's bytes from the read's.
  // `count(*)` cannot serve as that control because it takes the closed-form shortcut and never
  // walks at all, which is a confound rather than a baseline.
  hop1countx: 'MATCH (a:P)-[:E]->(x1:P) RETURN count(x1) AS c',
  hop1max: 'MATCH (a:P)-[:E]->(x1:P) RETURN max(x1.k) AS m',
  // The same fold reading the START variable instead of the far one, since the walk differs.
  hop1sumstart: 'MATCH (a:P)-[:E]->(x1:P) RETURN sum(a.k) AS s',
  hop1count: 'MATCH (a:P)-[:E]->(x1:P) RETURN count(*) AS c',
  hop2: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN x2.k AS k',
  hop2sum: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN sum(x2.k) AS s',
  // A clause WHERE disqualifies every chain rung, so this is the GENERAL matcher over the same rows
  // - the arm [[binding-allocation-is-closed]] priced a per-row `Map` in, indirectly.
  hop2generic: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) WHERE a.k >= 0 RETURN x2.k AS k',
  hop3: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P)-[:E]->(x3:P) RETURN x3.k AS k',
  hop3sum: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P)-[:E]->(x3:P) RETURN sum(x3.k) AS s',
  hop3collect: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P)-[:E]->(x3:P) RETURN collect(x3.k) AS ks',
};

/**
 * CHURN calibration: ONE multiplier per PROCESS, and the ratio read ACROSS processes.
 *
 * THE FIRST VERSION RAN 1x, 2x AND 4x IN ONE PROCESS AND REPORTED 1.00 / 2.62 / 9.00. That is this
 * repo's own "one shape per PROCESS" rule turned on the instrument itself: the later arms start on a
 * heap the earlier arms grew, V8 resizes `new_space` adaptively in response, and the accounting unit
 * therefore changes between arms. Run one per process and the ratio is read across them.
 *
 * Also printed is a SECOND, independent estimate - the scavenge count times the `new_space` bytes
 * each one reclaimed - because the event stream shows every scavenge firing at exactly a full
 * nursery (`before 5.10 -> after 4.11`, `new_space` used 1.00 MiB), so counting events is a
 * different route to the same number. Two routes agreeing is what made `gc-cost-probe.mjs`
 * trustworthy; two routes disagreeing here means the pairing is wrong and nothing below is readable.
 *
 *     for m in 1 2 4; do MULT=$m node --expose-gc allocprof-2416.mjs; done
 */
const calibrateChurn = async () => {
  const base = 65_536;
  const mult = Number(process.env.MULT ?? 1);
  const count = base * mult;
  const { out, churn, gc, newSpaceTotal } = await byChurn(() => burn(count, false));

  if (out === 0) {
    throw new Error('allocated nothing — a calibration of nothing');
  }

  console.log(
    `MULT=${String(mult)}  objects ${String(count)}  churn ${(churn / MIB).toFixed(2)} MiB  ` +
      `${(churn / count).toFixed(1)} B/object  across ${String(gc.count)} collections  ` +
      `[cross-check via nursery events: ${(newSpaceTotal / MIB).toFixed(2)} MiB]`,
  );
  console.log(
    '#   SOUND if B/object is flat across MULT and the two estimates agree; the absolute B/object ' +
      'is the object size, which is the quantity item 1361 assumed rather than measured',
  );
};

/** RETENTION calibration: the two arms must SPLIT, which is what proves what it measures. */
const calibrateRetained = async () => {
  console.log(
    '# CALIBRATION  MECH=retained  the two arms must SPLIT: sound for live, blind to churn',
  );

  const count = 2_097_152;

  for (const keep of [true, false]) {
    const { out, total, self } = await byRetained(() => burn(count, keep));
    const live = keep ? out.length : out;

    if (live === 0) {
      throw new Error('allocated nothing — a calibration of nothing');
    }

    const [top] = [...self.entries()].sort((a, b) => b[1] - a[1]);

    console.log(
      `  ${(keep ? 'retained' : 'garbage').padEnd(9)} reported ${(total / MIB).toFixed(1).padStart(7)} MiB  ` +
        `heapUsed ${(process.memoryUsage().heapUsed / MIB).toFixed(1)} MiB  ` +
        `top frame ${top === undefined ? '(none)' : `${top[0]} ${(top[1] / MIB).toFixed(1)} MiB`}`,
    );
  }

  console.log('#   EXPECTED: retained ~134 MiB, garbage ~0. Both large => it measures churn too;');
  console.log('#   both ~0 => item 1361 again and nothing below is readable.');
};

const run = async () => {
  if (SHAPE === 'cal') {
    await (MECH === 'retained' ? calibrateRetained() : calibrateChurn());

    return;
  }

  const text = SHAPES[SHAPE];

  if (text === undefined) {
    throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join('|')}`);
  }

  const g = buildGraph();
  // Warm, so the PARSE and PLAN caches ([[gql-perf-fastpaths]]) are not charged to the query.
  const warm = query(g, text, {});

  if (warm.length === 0) {
    throw new Error('the shape returned no rows — a zero-row arm allocates nothing');
  }

  console.log(`# SHAPE=${SHAPE} MECH=${MECH} NODES=${NODES} rows=${warm.length}`);
  console.log(`# ${text}`);

  if (MECH === 'gcshare') {
    const r = await byGcShare(() => query(g, text, {}), Math.max(REPS, 14));

    console.log(
      `  median ${r.median.toFixed(2)} ms   GC ${r.pauseMs.toFixed(1)} ms over ` +
        `${String(r.count)} collections = ${r.share.toFixed(1)}% of measured time`,
    );
    console.log(`  series ${r.series.map((x) => x.toFixed(1)).join(' ')}`);

    return;
  }

  if (MECH === 'churn') {
    for (let r = 0; r < REPS; r += 1) {
      const { out, churn, retained, gc } = await byChurn(() => query(g, text, {}));
      const rows = out.length;

      console.log(
        `  rep${String(r)}  churn ${(churn / MIB).toFixed(2).padStart(8)} MiB  ` +
          `${(churn / Math.max(rows, 1)).toFixed(0).padStart(5)} B/row  ` +
          `retained ${(retained / MIB).toFixed(2).padStart(7)} MiB  rows ${String(rows).padStart(7)}  ` +
          `across ${String(gc.count)} collections`,
      );
    }

    return;
  }

  const { total, self } = await byRetained(() => {
    let last;

    for (let r = 0; r < REPS; r += 1) {
      last = query(g, text, {});
    }

    return last;
  });

  console.log(`  surviving ${(total / MIB).toFixed(2)} MiB over ${REPS} reps`);

  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const pct = total === 0 ? 0 : (v / total) * 100;

    console.log(
      `    ${pct.toFixed(1).padStart(5)}%  ${(v / MIB).toFixed(2).padStart(8)} MiB  ${k}`,
    );
  }
};

await run();
