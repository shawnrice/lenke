/**
 * The SEEDED serving shapes, both surfaces, per operation (item 1596).
 *
 * Item 1595 took `V()[.hasLabel(L)].has(k, eq(v)).values(j)` from 2619 to 1709 ns against GQL's 650.
 * Its closing note named the next candidates — the same seek with a terminal OTHER than `values` —
 * but naming is not pricing. Gremlin already has a `countShortcut`, so a seeded count may cost
 * nothing at all, and building a shortcut for it would then be work against noise.
 *
 * ⚠️ MEASURE BEFORE BUILDING. Items 1587, 1589 and 1594 each built something the numbers then
 * refused, and the cheapest version of that lesson is to price the candidate first.
 *
 * Each row is one question asked both ways over an indexed graph, answers asserted equal.
 *
 *     node seeded-serving-shapes-probe.mjs
 *     ONLY=count node seeded-serving-shapes-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 120_000);
const { ONLY } = process.env;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });

/**
 * `name` is UNIQUE (one hit per seek) and `team` has 400 hits — both matter, because a shortcut that
 * only pays at N=1 is a different claim from one that pays per hit.
 */
const SHAPES = [
  {
    name: 'values, unique key',
    gql: (i) => ['MATCH (u:User) WHERE u.name = $v RETURN u.score AS s', { v: `user${i % NODES}` }],
    grem: (i) =>
      G.traversal(
        G.V(),
        G.hasLabel('User'),
        G.has('name', G.eq(`user${i % NODES}`)),
        G.values('score'),
      ),
  },
  {
    name: 'values, 400 hits',
    gql: (i) => ['MATCH (u:User) WHERE u.team = $v RETURN u.score AS s', { v: `t${i % 50}` }],
    grem: (i) =>
      G.traversal(G.V(), G.hasLabel('User'), G.has('team', G.eq(`t${i % 50}`)), G.values('score')),
  },
  {
    name: 'count, unique key',
    gql: (i) => [
      'MATCH (u:User) WHERE u.name = $v RETURN count(*) AS c',
      { v: `user${i % NODES}` },
    ],
    grem: (i) =>
      G.traversal(G.V(), G.hasLabel('User'), G.has('name', G.eq(`user${i % NODES}`)), G.count()),
  },
  {
    name: 'count, 400 hits',
    gql: (i) => ['MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: `t${i % 50}` }],
    grem: (i) =>
      G.traversal(G.V(), G.hasLabel('User'), G.has('team', G.eq(`t${i % 50}`)), G.count()),
  },
  {
    name: 'element, unique key',
    gql: (i) => ['MATCH (u:User) WHERE u.name = $v RETURN u', { v: `user${i % NODES}` }],
    grem: (i) => G.traversal(G.V(), G.hasLabel('User'), G.has('name', G.eq(`user${i % NODES}`))),
  },
  {
    name: 'id, unique key',
    gql: (i) => ['MATCH (u:User) WHERE u.name = $v RETURN u.name AS n', { v: `user${i % NODES}` }],
    grem: (i) =>
      G.traversal(
        G.V(),
        G.hasLabel('User'),
        G.has('name', G.eq(`user${i % NODES}`)),
        G.values('name'),
      ),
  },
];

const nsPerOp = (fn) => {
  for (let i = 0; i < 2000; i += 1) {
    fn(i);
  }

  const rounds = [];

  for (let r = 0; r < 3; r += 1) {
    const t0 = performance.now();

    for (let i = 0; i < REPS; i += 1) {
      fn(i);
    }

    rounds.push(((performance.now() - t0) * 1e6) / REPS);
  }

  return Math.min(...rounds);
};

/**
 * Reduce either surface's answer to one comparable, so a row cannot compare different questions.
 *
 * ⚠️ AN ELEMENT NEEDS ITS OWN ARM, and leaving it out produced a FALSE "answers differ" on the
 * element row: `query` returns a ROW OBJECT (`{u: <vertex>}`) while `toArray` returns the BARE
 * vertex, and a Vertex's enumerable own-properties are empty (its state is in private fields), so
 * `Object.values(first)[0]` was `undefined` for Gremlin and the whole vertex for GQL. The timings
 * either side of that were fine, which is exactly how a bad normalizer survives — item 1581's
 * cross-surface probe shipped the same mistake in the other direction.
 *
 * An element is compared by its ID, which is the only part both surfaces agree to expose.
 */
const idOf = (v) =>
  v !== null && typeof v === 'object' && 'id' in v ? `#${String(v.id)}` : undefined;
const norm = (out) => {
  if (!Array.isArray(out)) {
    return out ?? null;
  }

  const [first] = out;
  const direct = idOf(first);

  if (direct !== undefined) {
    return `${out.length}:${direct}`;
  }

  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    const [only] = Object.values(first);

    return `${out.length}:${idOf(only) ?? JSON.stringify(only ?? null)}`;
  }

  return `${out.length}:${JSON.stringify(first ?? null)}`;
};

console.log(`${NODES} vertices, ${REPS} ops/round, min of 3. ns per operation.\n`);

for (const shape of SHAPES) {
  if (ONLY !== undefined && !shape.name.includes(ONLY)) {
    continue;
  }

  const runGql = (i) => {
    const [text, params] = shape.gql(i);

    return query(g, text, params);
  };
  const runGrem = (i) => G.toArray(shape.grem(i), g);
  // ⚠️ Element rows cannot be compared as rendered objects across surfaces — GQL returns a row
  // object and Gremlin a bare element — so the comparable is the COUNT plus the first value, which
  // is what `norm` reduces to.
  const a = norm(runGql(1));
  const b = norm(runGrem(1));
  const q = nsPerOp(runGql);
  const r = nsPerOp(runGrem);

  console.log(
    `${shape.name.padEnd(22)} gql ${q.toFixed(0).padStart(6)}  gremlin ${r.toFixed(0).padStart(6)}  ` +
      `${(r / q).toFixed(2)}x  ${a === b ? 'answers agree' : `⚠ DIFFER gql=${a} grem=${b}`}`,
  );
}
