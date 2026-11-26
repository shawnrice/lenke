/**
 * ITEM 2231 — WRITES UNDER A TRANSACTION, the one serving shape no screen row exercises.
 *
 * Items 2181/2184 worked the per-op tx penalty (340.2 → 171.0 ns/op) by skipping `txTouched.add` when
 * no deferrable check exists. This asks the floored question instead: **what does a transaction COST per
 * write, against the same writes outside one, and against a raw `Map.set` floor?**
 *
 * ONE ARM PER PROCESS (`ARM=`), a CHEAP sink (item 2227: `JSON.stringify` in the loop dilutes toward
 * 1.0), and a fresh graph per rep so no arm inherits another's size.
 */
import { Graph } from '@lenke/core';

const OPS = Number(process.env.OPS ?? 100_000);
const REPS = Number(process.env.REPS ?? 7);
const keys: string[] = [];

for (let i = 0; i < OPS; i += 1) {
  keys.push(`v${i}`);
}

/** The floor: a raw `Map.set` per op, no graph at all. */
const rawMap = (): number => {
  const m = new Map<string, { k: number }>();

  for (let o = 0; o < OPS; o += 1) {
    m.set(keys[o], { k: o });
  }

  return m.size;
};

/**
 * **KEY CARDINALITY IS A FIXTURE CHOICE AND IT DECIDES THE ANSWER.** `CARD` sets how many DISTINCT
 * values the indexed key takes: `CARD=0` (the default) makes every key UNIQUE, so a bucketed index
 * allocates one bucket per row — the worst case, and the only case a UNIQUE CONSTRAINT can have. A small
 * `CARD` reuses buckets, which is the common case for a plain index.
 *
 * `CLAUDE.md`'s "match the fixture to the claim": a per-write index cost measured only at unique keys
 * would be a statement about constraints masquerading as one about indexes.
 */
const CARD = Number(process.env.CARD ?? 0);

const addVertices = (g: Graph): number => {
  for (let o = 0; o < OPS; o += 1) {
    g.addVertex({ id: keys[o], labels: ['P'], properties: { k: CARD > 0 ? o % CARD : o } });
  }

  return g.vertexCount;
};

/** The same writes, inside ONE transaction. */
const inOneTx = (): number => {
  const g = new Graph();
  let n = 0;

  g.transaction(() => {
    n = addVertices(g);
  });

  return n;
};

/** The same writes, each in its OWN transaction — the per-transaction overhead, not the per-write one. */
const inManyTx = (): number => {
  const g = new Graph();

  for (let o = 0; o < OPS; o += 1) {
    g.transaction(() => {
      g.addVertex({ id: keys[o], labels: ['P'], properties: { k: o } });
    });
  }

  return g.vertexCount;
};

/** A CONSTRAINT makes the deferred-check path live — item 2181's skip no longer applies. */
const inTxWithConstraint = (): number => {
  const g = new Graph();

  /* POSITIONAL, not an options object — `(label, key)`. */
  g.createUniqueConstraint('P', 'k');

  let n = 0;

  g.transaction(() => {
    n = addVertices(g);
  });

  return n;
};

/**
 * THE CONTROL THAT SEPARATES "constraint" FROM "constraint + transaction". Item 2181's skip only applies
 * when NO deferrable check exists, so a live constraint is the complement of that win — and whether its
 * cost is the CHECK or the TX bookkeeping is exactly what this arm answers.
 */
const constraintNoTx = (): number => {
  const g = new Graph();

  g.createUniqueConstraint('P', 'k');

  return addVertices(g);
};

/** A plain INDEX on the same key, no constraint: the index maintenance alone. */
const indexNoConstraint = (): number => {
  const g = new Graph();

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

  return addVertices(g);
};

/**
 * **THE HONEST FLOOR FOR INDEX MAINTENANCE: `addVertex` PLUS a hand-rolled bucketed insert.** Item
 * 2232's profile put `addEntry` at 116 ns/write and the GC it causes at 75, but 116 ns is only a target if
 * a hand-rolled `Map.get` + `Set.add` is materially cheaper — and that is what this arm measures.
 *
 * It does the SAME WORK: one bucket lookup, one bucket create when absent, one add.
 */
const handRolledIndex = (): number => {
  const g = new Graph();
  const buckets = new Map<unknown, Set<string>>();

  for (let o = 0; o < OPS; o += 1) {
    g.addVertex({ id: keys[o], labels: ['P'], properties: { k: CARD > 0 ? o % CARD : o } });

    const key = CARD > 0 ? o % CARD : o;
    let bucket = buckets.get(key);

    if (bucket === undefined) {
      bucket = new Set<string>();
      buckets.set(key, bucket);
    }

    bucket.add(keys[o]);
  }

  return g.vertexCount;
};

const arm = process.env.ARM ?? 'notx';

const run = (): number => {
  if (arm === 'floor') {
    return rawMap();
  }

  if (arm === 'onetx') {
    return inOneTx();
  }

  if (arm === 'manytx') {
    return inManyTx();
  }

  if (arm === 'constraint') {
    return inTxWithConstraint();
  }

  if (arm === 'connotx') {
    return constraintNoTx();
  }

  if (arm === 'index') {
    return indexNoConstraint();
  }

  if (arm === 'handindex') {
    return handRolledIndex();
  }

  return addVertices(new Graph());
};

let sink = 0;

for (let w = 0; w < 2; w += 1) {
  sink += run();
}

const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  sink += run();
}

const nsPerOp = ((performance.now() - t0) * 1e6) / REPS / OPS;

console.log(
  `  ${arm.padEnd(11)} ${nsPerOp.toFixed(0).padStart(6)} ns/write  (sink ${sink > 0 ? 'ok' : 'ZERO'})`,
);
