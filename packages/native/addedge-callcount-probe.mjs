/**
 * How many times does `addEdge` actually call each by-id lookup, and what do the write path's
 * hot frames cost PER CALL? (item 1819)
 *
 * ⚠️ WHY A COUNT AND NOT A SHARE. `runtime-profile-write-probe.mjs addEdgeOnly` profiles
 * `getEdgeById` at **16.8% self**, 187.4 ms over 600,000 edges — 312 ns a call if it is called once
 * per edge. But `getEdgeById` is one line, `this.edgesById.get(id) ?? null`, and the same probe's
 * `pointLookups` shape measures a by-id lookup at **4.5 ns**. A one-line `Map.get` cannot be both.
 *
 * So the share is either mis-attributed inlined work (`frame-attribution-trap`: "a FIELD READ or
 * GETTER frame is attribution until a deletion test with a CONTROL says otherwise", four instances
 * on record) or the function is called MANY times per edge. Those have opposite fixes, and only a
 * COUNT tells them apart. PROBES.md's own rule: a share is a nomination, an ablation is the price.
 *
 * ⚠️ THE WRAPPER WORKS ONLY BECAUSE THESE ARE CLASS-FIELD ARROWS, not prototype methods — they are
 * own properties of the instance (`getVertexById = (id) => …`), so assigning over them on one graph
 * replaces them for that graph alone and the captured original stays callable with its own `this`.
 * If they are ever moved onto the prototype this probe silently counts nothing, which is why it
 * ASSERTS a non-zero count rather than reporting a clean zero.
 *
 *     node addedge-callcount-probe.mjs
 *     N=50000 FANOUT=5 node addedge-callcount-probe.mjs
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);

const buildVertices = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'] }));
  }

  return { g, vs };
};

/** The same edge stride the write probe uses, so a number here is comparable with that screen. */
const addEdges = (g, vs) => {
  for (let k = 0; k < N * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % N],
      to: vs[((k % N) * 104_729 + Math.floor(k / N) * 977) % N],
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g.edgeCount;
};

// ── 1. THE COUNT ────────────────────────────────────────────────────────────────────────────────
{
  const { g, vs } = buildVertices();
  const counts = {};

  for (const name of ['getEdgeById', 'getVertexById', 'getEdgesByLabel', 'getVerticesByLabel']) {
    const original = g[name];

    if (typeof original !== 'function') {
      throw new Error(`${name} is not a function on a Graph instance — probe needs updating`);
    }

    counts[name] = 0;
    g[name] = (arg) => {
      counts[name] += 1;

      return original(arg);
    };
  }

  const edges = addEdges(g, vs);

  console.log(`# addedge-callcount-probe N=${N} FANOUT=${FANOUT} edges=${edges}`);
  console.log(`# calls made DURING ${edges} addEdge calls:`);

  for (const [name, n] of Object.entries(counts)) {
    console.log(
      `    ${name.padEnd(20)} ${String(n).padStart(9)}   ${(n / edges).toFixed(3)} per edge`,
    );
  }

  // ⚠️ A zero here is the probe failing, not a finding — see the class-field note above. The
  // vertex lookup is the one guaranteed non-zero: `addEdge` is given vertex OBJECTS by this probe,
  // so if even that is zero the wrapper is not installed on the object under test.
  if (Object.values(counts).every((n) => n === 0)) {
    throw new Error('every wrapper counted ZERO — the wrappers are not installed, not a result');
  }
}

// ── 2. THE PRICE OF THE LOOKUP ITSELF, measured on the same graph ───────────────────────────────
{
  const { g, vs } = buildVertices();

  addEdges(g, vs);

  const ids = [];

  for (let k = 0; k < 100_000; k += 1) {
    ids.push(`e${(k * 7919) % (N * FANOUT)}`);
  }

  const time = (label, fn) => {
    for (let w = 0; w < 3; w += 1) {
      fn();
    }

    const series = [];

    for (let r = 0; r < 7; r += 1) {
      const t0 = performance.now();
      const sink = fn();

      series.push(performance.now() - t0);

      if (sink === 0) {
        throw new Error(`${label} looked nothing up — the ids are wrong`);
      }
    }

    series.sort((a, b) => a - b);

    const ms = series[series.length >> 1];

    console.log(
      `    ${label.padEnd(20)} ${ms.toFixed(2).padStart(7)} ms / ${ids.length} ` +
        `= ${((ms * 1e6) / ids.length).toFixed(1)} ns each`,
    );

    return ms;
  };

  console.log('# the lookups priced directly, 100,000 ids over a warm graph:');

  time('getEdgeById', () => {
    let hit = 0;

    for (const id of ids) {
      if (g.getEdgeById(id) !== null) {
        hit += 1;
      }
    }

    return hit;
  });

  time('getVertexById', () => {
    let hit = 0;

    for (let k = 0; k < ids.length; k += 1) {
      if (g.getVertexById(`v${k % N}`) !== null) {
        hit += 1;
      }
    }

    return hit;
  });
}
