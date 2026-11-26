// Item 1969 — IS `getVertexById` AS CHEAP AS THE `Map.get` IT IS? The standing requirement is O(1)
// access to a vertex or edge by id, so this checks both halves: the COMPLEXITY (does it scale?) and
// the CONSTANT (does the wrapper cost anything over the map?).
//
// `getVertexById` is literally `this.verticesById.get(id) ?? null`, so O(1) is not in doubt — but
// item 194 priced it at **~190 ns at bench size**, and a string-keyed `Map.get` should be a fraction
// of that. The call also matters at volume: `Graph.ts` records **four `getVertexById` calls per
// edge, 4,000,000 to ingest a million**, and it profiles at 8-16% of every fixture build in this
// session's probes.
//
// THE ARMS, and the point is to separate the wrapper from the lookup:
//
//     mapGet      `g.verticesById.get(id)`      the floor — the map itself
//     byId        `g.getVertexById(id)`         the public accessor
//     edgeById    `g.getEdgeById(id)`           its edge twin
//     missing     `g.getVertexById(absent)`     the `?? null` arm, which a hit never takes
//
// `getVertexById` IS A PER-INSTANCE ARROW CLASS FIELD, not a prototype method, so each `Graph`
// carries its own function object. For ONE graph a call site stays monomorphic; the reason to
// measure rather than argue is that a wrapper around a `Map.get` is exactly the shape V8 either
// inlines to nothing or does not.
//
// THE KEYS ARE SHUFFLED AND READ FROM AN ARRAY, so the loop measures lookups rather than string
// construction — building `String(i)` inside the timed loop would measure the allocator.
//
//     bun byidcost-1969.mjs
import { Graph } from '@lenke/core';

const REPS = Number(process.env.REPS ?? 9);
const SIZES = (process.env.SIZES ?? '10000,100000,1000000').split(',').map(Number);
const f = (x) => x.ns.toFixed(1).padStart(7);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const build = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i } });
  }

  // One edge per vertex, so `getEdgeById` has the same population to look into.
  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${String(i)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3) % n) + 1)),
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** A deterministic shuffle, so every arm walks the same non-sequential key order. */
const shuffled = (n, prefix) => {
  const keys = [];

  for (let i = 0; i < n; i += 1) {
    keys.push(`${prefix}${String((i * 2_654_435_761) % n)}`);
  }

  return keys;
};

const time = (fn, keys) => {
  const ts = [];
  let seen = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    seen = fn(keys);

    ts.push(performance.now() - t0);
  }

  return { ns: (med(ts) * 1e6) / keys.length, seen };
};

console.log(`REPS=${String(REPS)} median, ns per lookup\n`);
console.log('n          mapGet   byId   edgeById  missing    hits (guard)');

for (const n of SIZES) {
  const g = build(n);
  // Vertex ids are `1..n`; the shuffle generates `0..n-1`, so shift by one for a hit every time.
  const vKeys = shuffled(n, '').map((k) => String(Number(k) + 1));
  const eKeys = shuffled(n, 'e');
  const absent = vKeys.map((k) => `${k}-nope`);

  const a = time((keys) => {
    const m = g.verticesById;
    let hit = 0;

    for (const k of keys) {
      if (m.get(k) !== undefined) {
        hit += 1;
      }
    }

    return hit;
  }, vKeys);

  const b = time((keys) => {
    let hit = 0;

    for (const k of keys) {
      if (g.getVertexById(k) !== null) {
        hit += 1;
      }
    }

    return hit;
  }, vKeys);

  const c = time((keys) => {
    let hit = 0;

    for (const k of keys) {
      if (g.getEdgeById(k) !== null) {
        hit += 1;
      }
    }

    return hit;
  }, eKeys);

  const d = time((keys) => {
    let hit = 0;

    for (const k of keys) {
      if (g.getVertexById(k) !== null) {
        hit += 1;
      }
    }

    return hit;
  }, absent);

  console.log(
    `${String(n).padEnd(10)} ${f(a)} ${f(b)} ${f(c)} ${f(d)}    ${String(a.seen)}/${String(b.seen)}/${String(c.seen)}/${String(d.seen)}`,
  );

  // The microtask drain pins a discarded Graph in full — `graph-pinned-until-microtask-drain`.
  await new Promise((r) => setTimeout(r, 0));
}

console.log(
  '\nO(1) is the flatness of these columns across n, not any single row. The `hits` guard must read n/n/n/0.',
);
