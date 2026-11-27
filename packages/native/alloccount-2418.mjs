/**
 * CAN NODE COUNT ALLOCATIONS THE WAY RUST'S COUNTING `GlobalAlloc` DOES? Calibration first.
 *
 * Item 2416 asserted that "JS exposes no allocation hook" WITHOUT VERIFYING IT, which is why its
 * churn meter reports
 * BYTES and no count, and item 2417 recorded the resulting asymmetry: the Rust probe
 * (`examples/alloc_count_probe.rs`) gives allocation COUNT plus a size histogram, which localizes a
 * site ("12 of exactly 8 bytes, all in `lex`") where a byte total cannot.
 *
 * THAT ASSERTION WAS NOT VERIFIED, and there is a third `HeapProfiler` API it overlooked.
 * Item 2416 tried `HeapProfiler.startSampling` (sound for RETAINED bytes, blind to churn) and the
 * `--heap-prof` CLI wrapper (item 1361's verdict). But `startTrackingHeapObjects` with
 * `trackAllocations: true` is DevTools' "allocation instrumentation on timeline": V8 then records
 * every allocation against its call site, and the heap snapshot taken afterwards carries a
 * `trace_tree` whose nodes hold a `count` and a `size` per site. That is the same two numbers the
 * Rust allocator reports.
 *
 * CALIBRATED BEFORE ANY ENGINE NUMBER IS READ, which is item 2416's own rule and the reason three of
 * its mechanisms were caught lying first:
 *
 *   - the GARBAGE arm is the one that matters, because churn is the question the other two
 *     mechanisms cannot answer. A sound counter reports ~COUNT allocations and names `burn`.
 *   - objects are stored into a module-level slot so they ESCAPE. A naive `const o = {...}` is
 *     deleted by escape analysis and allocates nothing (item 2416: churn/object fell 51.3 -> 29.7 B
 *     as the count grew), so it cannot calibrate a counter either.
 *   - LINEARITY over a 4x range, since an absolute count is only known for the objects themselves
 *     (one per iteration) and not for the strings and buffer growth around them.
 *
 *     node alloccount-2418.mjs                  # calibrate at COUNT=250000
 *     COUNT=1000000 node alloccount-2418.mjs    # linearity
 *     SHAPE=hop1sum node alloccount-2418.mjs    # an engine shape, once calibrated
 */
import { Session } from 'node:inspector';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const COUNT = Number(process.env.COUNT ?? 250_000);
const SHAPE = process.env.SHAPE ?? 'cal';
const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 1);
const TOP = Number(process.env.TOP ?? 12);

const SINK = new Array(1024).fill(null);

/** The ONE named allocation site: escapes (really allocated), overwritten (really garbage). */
const burn = (n) => {
  for (let i = 0; i < n; i += 1) {
    SINK[i & 1023] = { a: i, b: i + 1, c: `s${i & 1023}`, d: null };
  }

  return SINK.length;
};

/**
 * Allocation COUNT and SIZE per call site, from the allocation tracker's trace tree.
 *
 * The snapshot arrives as `addHeapSnapshotChunk` events rather than as the call's result, so the
 * chunks are collected off the session and concatenated before parsing. `trace_function_infos` is a
 * FLAT array of records whose width is given by `snapshot.meta.trace_function_info_fields`, and
 * `trace_tree` nodes are likewise flat records of `trace_node_fields` width with their children
 * nested in the last field - so both are decoded from the meta rather than from assumed offsets.
 */
const byAllocationSite = async (fn) => {
  const session = new Session();

  session.connect();

  const post = (method, params) =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
    });

  /*
   * COLLECT CHUNKS FOR EXACTLY ONE SNAPSHOT. `stopTrackingHeapObjects` emits a snapshot of its own
   * on top of the one `takeHeapSnapshot` asks for, so a listener left armed across both
   * concatenates two JSON documents and `JSON.parse` fails with "Unexpected non-whitespace
   * character after JSON at position 6705966" - which reads like a corrupt snapshot rather than
   * two good ones.
   */
  let chunks = [];
  let collecting = false;

  session.on('HeapProfiler.addHeapSnapshotChunk', (m) => {
    if (collecting) {
      chunks.push(m.params.chunk);
    }
  });

  await post('HeapProfiler.enable');
  // `trackAllocations` IS THE WHOLE POINT: without it the snapshot carries no trace tree and this
  // degenerates into the retained-bytes instrument item 2416 already has.
  await post('HeapProfiler.startTrackingHeapObjects', { trackAllocations: true });

  const out = fn();

  chunks = [];
  collecting = true;
  await post('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  collecting = false;
  await post('HeapProfiler.stopTrackingHeapObjects');
  await post('HeapProfiler.disable');
  session.disconnect();

  const snap = JSON.parse(chunks.join(''));
  const { meta } = snap.snapshot;
  const infoFields = meta.trace_function_info_fields;
  const nodeFields = meta.trace_node_fields;

  if (infoFields === undefined || nodeFields === undefined) {
    throw new Error(
      'the snapshot carries no allocation trace tree — `trackAllocations` did not take effect, ' +
        'and a zero count from this probe would be a lie',
    );
  }

  const iw = infoFields.length;
  const nameIdx = infoFields.indexOf('name');
  const scriptIdx = infoFields.indexOf('script_name');
  const lineIdx = infoFields.indexOf('line');

  /** `function_info_index` -> a readable site. */
  const siteOf = (idx) => {
    const base = idx * iw;
    // An EMPTY name is the common case for an anonymous function, so the fallback must trigger on
    // `''` as well as on absence - which is why this is not `??`.
    const rawName = snap.strings[snap.trace_function_infos[base + nameIdx]];
    const rawScript = snap.strings[snap.trace_function_infos[base + scriptIdx]];
    const name = rawName === undefined || rawName === '' ? '(anonymous)' : rawName;
    const script = rawScript === undefined || rawScript === '' ? '(native)' : rawScript;
    const line = snap.trace_function_infos[base + lineIdx];

    return `${name}  ${String(script).split('/').pop()}:${String(line)}`;
  };

  const fnIdx = nodeFields.indexOf('function_info_index');
  const cntIdx = nodeFields.indexOf('count');
  const szIdx = nodeFields.indexOf('size');
  const childIdx = nodeFields.indexOf('children');

  const sites = new Map();
  let totalCount = 0;
  let totalSize = 0;

  // `trace_tree` is a nested array: each node is `nodeFields.length` flat values, the last of
  // which is an array of child nodes in the same shape.
  const walk = (nodes) => {
    for (let i = 0; i < nodes.length; i += nodeFields.length) {
      const site = siteOf(nodes[i + fnIdx]);
      const count = nodes[i + cntIdx];
      const size = nodes[i + szIdx];
      const prev = sites.get(site) ?? { count: 0, size: 0 };

      sites.set(site, { count: prev.count + count, size: prev.size + size });
      totalCount += count;
      totalSize += size;

      const kids = nodes[i + childIdx];

      if (Array.isArray(kids) && kids.length > 0) {
        walk(kids);
      }
    }
  };

  walk(snap.trace_tree);

  let engineCount = 0;
  let engineSize = 0;

  for (const [site, v] of sites) {
    if (!isTransport(site)) {
      engineCount += v.count;
      engineSize += v.size;
    }
  }

  return { out, totalCount, totalSize, sites, engineCount, engineSize };
};

/**
 * Frames belonging to the INSTRUMENT rather than to the engine, excluded from the totals.
 *
 * Without this the headline is nonsense: the snapshot arrives as `addHeapSnapshotChunk` events, so
 * the inspector channel allocates the chunk strings INSIDE the measured window, and `#onMessage
 * node:inspector` showed 44.01 MiB against the engine's 1.96 - turning a real ~103 B/element into a
 * reported "4949.0 B/element". The COUNTS were never affected (215 allocations against the engine's
 * 34,634); only the byte totals, and only because a few allocations are enormous.
 *
 * Matched by SOURCE, and `(V8 API)` by name because it is the snapshot serializer. NOT all of
 * `(native):0`, which was the first version and was too broad: `next` and `values` are native frames
 * doing the ENGINE'S iterator work, and excluding them under-counted the engine by ~47,000
 * allocations while leaving them visible in the per-site table - a total disagreeing with its own
 * breakdown.
 */
const TRANSPORT_FRAMES = ['node:inspector', 'node:events', '(V8 API)'];

const isTransport = (site) => TRANSPORT_FRAMES.some((f) => site.includes(f));

const buildGraph = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
  }

  for (let e = 0; e < NODES; e += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${e}`),
      to: g.getVertexById(`v${(e * 7 + 3) % NODES}`),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const SHAPES = {
  hop1: 'MATCH (a:P)-[:E]->(x1:P) RETURN x1.k AS k',
  hop1sum: 'MATCH (a:P)-[:E]->(x1:P) RETURN sum(x1.k) AS s',
  hop1max: 'MATCH (a:P)-[:E]->(x1:P) RETURN max(x1.k) AS m',
  hop1count: 'MATCH (a:P)-[:E]->(x1:P) RETURN count(*) AS c',
  hop2: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN x2.k AS k',
  hop2sum: 'MATCH (a:P)-[:E]->(x1:P)-[:E]->(x2:P) RETURN sum(x2.k) AS s',
};

const show = (label, r, per) => {
  const engine = `${String(r.engineCount)} allocations, ${(r.engineSize / 1048576).toFixed(2)} MiB`;
  const withTransport = `${String(r.totalCount)} / ${(r.totalSize / 1048576).toFixed(2)} MiB with it`;
  const perEl =
    per === undefined
      ? ''
      : `  => ${(r.engineCount / per).toFixed(2)} allocs/element, ${(r.engineSize / per).toFixed(1)} B/element`;

  console.log(`${label}  ${engine} (excluding the inspector transport; ${withTransport})${perEl}`);

  for (const [site, v] of [...r.sites.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, TOP)) {
    console.log(
      `    ${String(v.count).padStart(9)} allocs  ${(v.size / 1048576).toFixed(2).padStart(8)} MiB  ${site}`,
    );
  }
};

if (SHAPE === 'cal') {
  const r = await byAllocationSite(() => burn(COUNT));

  if (r.out === 0) {
    throw new Error('allocated nothing — a calibration of nothing');
  }

  console.log(
    `# CALIBRATION  ${String(COUNT)} escaping-then-garbage objects through one site \`burn\``,
  );
  show('#', r, COUNT);
  console.log(
    `#   SOUND if the count is >= COUNT (one object each, plus a string per iteration), \`burn\` is NAMED, and allocs/element is FLAT across COUNT. Compare 250000 against 1000000.`,
  );
} else {
  const text = SHAPES[SHAPE];

  if (text === undefined) {
    throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join('|')}`);
  }

  const g = buildGraph();
  // Warm, so the parse and plan caches are not charged to the query.
  const warm = query(g, text, {});

  if (warm.length === 0) {
    throw new Error('the shape returned no rows');
  }

  // The number of elements the shape WALKS, which is what a per-element claim divides by. At
  // FANOUT=1 every depth walks NODES rows, so this is the walk and not the output.
  const walked = NODES * REPS;
  const r = await byAllocationSite(() => {
    let last;

    for (let i = 0; i < REPS; i += 1) {
      last = query(g, text, {});
    }

    return last;
  });

  console.log(`# SHAPE=${SHAPE} NODES=${NODES} REPS=${REPS} rows=${warm.length} walked=${walked}`);
  console.log(`# ${text}`);
  show('#', r, walked);
}
