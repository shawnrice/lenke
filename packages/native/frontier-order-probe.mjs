/**
 * Is a chain walk's cost recoverable by changing VISIT ORDER rather than the graph?
 *
 * Item 1815 measured a 9x spread between two fixtures that differ only in how far apart consecutive
 * hops land (`chain` 153 ns/row against `compound` 1362 at 200,000 nodes, depth 3). That spread is
 * the cost of locality — but it was measured by CHANGING THE GRAPH, which a real user cannot do.
 * The question this probe asks is the one that matters: holding the graph fixed, how much of that
 * spread does a different VISIT ORDER recover?
 *
 * ⚠️ WHY THIS IS A PROBE AND NOT AN ENGINE CHANGE. `descend` is depth-first: it chases one path to
 * the leaf before touching the level above's next edge, so the vertices it dereferences at depth k
 * arrive in start order permuted by the topology. A level-synchronous walk can instead collect each
 * level's frontier and visit it in MEMORY order. That is a real design, and it is also the design
 * whose ordering key was BUILT AND DISQUALIFIED at items 1369-1372/1397 — a dense vertex ordinal
 * cost deletes 6.18x/11.34x under churn. So the ceiling gets priced FIRST, by hand, outside the
 * engine; nothing is designed until the number says it is worth designing. Seven items have already
 * arrived at the ordinal and this is not going to be the eighth on a hunch.
 *
 * THE ARMS, all three over the SAME graph, all three asserted to return the same row multiset:
 *
 *     dfs       recursive descent, one path to the leaf at a time — what `chainProjection` does
 *     level     level-synchronous: materialize each level's frontier, then expand it
 *     sorted    level-synchronous, each frontier SORTED BY INSERTION INDEX before expanding
 *
 * `level` is the control that makes `sorted` mean something. Going level-synchronous changes the
 * allocation profile all by itself (a frontier array per level instead of a stack), so without it a
 * `sorted` win could be the restructuring rather than the ordering. The ordering's own contribution
 * is `level -> sorted`; `dfs -> level` is the restructuring's.
 *
 * ⚠️ THE ORDERING KEY IS FREE HERE AND WOULD NOT BE IN THE ENGINE. This probe reads an insertion
 * index captured once at build time into a plain array. In the engine that key is exactly the dense
 * ordinal item 1372 disqualified, so a win measured here is an OPTIMISTIC CEILING: it pays nothing
 * for maintaining the key under writes, and it still leaves the edge objects and adjacency buckets
 * scattered. Read a positive result as "worth designing", never as "worth this much".
 *
 *   node frontier-order-probe.mjs <depth> <nodes> <compound|chain|scattered> <reps>
 */

import { Graph } from '@lenke/core';

const [, , depthArg, nodesArg, strideArg, repsArg] = process.argv;

const DEPTH = Number(depthArg ?? 3);
const NODES = Number(nodesArg ?? 200_000);
const STRIDE = strideArg ?? 'compound';
const REPS = Number(repsArg ?? 8);

if (!Number.isInteger(DEPTH) || DEPTH < 1 || DEPTH > 6) {
  throw new Error(`depth must be an integer 1..6, got ${depthArg}`);
}

if (STRIDE !== 'compound' && STRIDE !== 'chain' && STRIDE !== 'scattered') {
  throw new Error(`stride must be compound|chain|scattered, got ${strideArg}`);
}

const target = (i) => {
  if (STRIDE === 'chain') {
    return (i + 1) % NODES;
  }

  if (STRIDE === 'scattered') {
    return (i * 104_729) % NODES;
  }

  return (i * 7 + 3) % NODES;
};

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${target(i)}`),
    labels: ['E'],
    properties: { w: i % 13 },
  });
}

/** The starts, in the order the engine's label elision yields them (`verticesByLabel` insertion). */
const starts = [...(g.verticesByLabel.get('P') ?? [])];

/**
 * The ordering key, captured ONCE. In the engine this is item 1372's disqualified dense ordinal, so
 * its absence from the timed region is the whole reason a win here is a ceiling and not a price.
 */
const ordinal = new Map();

for (const [i, v] of starts.entries()) {
  ordinal.set(v, i);
}

const step = (v) => v.adjFrom?.get('E') ?? undefined;

/** Arm `dfs`: one path to the leaf at a time, which is `descend`'s order. */
const runDfs = () => {
  const out = [];

  const go = (level, v) => {
    const bucket = step(v);

    if (bucket === undefined) {
      return;
    }

    for (const e of bucket) {
      const w = e.to;

      if (level + 1 === DEPTH) {
        out.push(w.properties.k);
      } else {
        go(level + 1, w);
      }
    }
  };

  for (const s of starts) {
    go(0, s);
  }

  return out;
};

/** Arms `level` and `sorted`: materialize each frontier, optionally in memory order, then expand. */
const runLevel = (sort) => {
  let frontier = starts;
  const out = [];

  for (let level = 0; level < DEPTH; level += 1) {
    const emitting = level + 1 === DEPTH;
    const next = emitting ? undefined : [];

    if (sort) {
      // ⚠️ IN THE TIMED REGION ON PURPOSE. The sort is a real cost of the design, so excluding it
      // would price a mechanism nobody could ship. Only the KEY's maintenance is excluded, and the
      // header says why that makes this a ceiling.
      frontier = [...frontier].sort((a, b) => ordinal.get(a) - ordinal.get(b));
    }

    for (const v of frontier) {
      const bucket = step(v);

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        const w = e.to;

        if (emitting) {
          out.push(w.properties.k);
        } else {
          next.push(w);
        }
      }
    }

    if (!emitting) {
      frontier = next;
    }
  }

  return out;
};

/**
 * Arm `blocked`: level-synchronous WITHIN A FIXED-SIZE BLOCK of starts, with the two frontier
 * buffers allocated ONCE and reused across blocks and levels.
 *
 * ⚠️ THIS ARM EXISTS BECAUSE `level` LOSES WHERE LOCALITY IS ALREADY GOOD, AND THE LOSS IS
 * ALLOCATION RATHER THAN BATCHING: at 200,000 nodes on the `chain` stride it runs 0.60-0.71x of
 * `dfs`, paying a 200,000-element array per level for a walk that was already ~16 ns/row. Blocking
 * bounds the live frontier to BLOCK entries — small enough to stay resident, reused rather than
 * reallocated — so it keeps `dfs`'s allocation profile while still touching each level's vertices
 * in one pass. If it wins or ties everywhere, the conditional 2x becomes unconditional and no
 * locality predictor is needed; if it merely splits the difference, the gate is unavoidable and
 * that is the finding.
 */
const BLOCK = Number(process.env.BLOCK ?? 4096);

/** Write at `i`, growing only when the buffer is actually full — hoisted to satisfy max-depth. */
const put = (buf, i, v) => {
  if (i === buf.length) {
    buf.push(v);
  } else {
    buf[i] = v;
  }
};

const runBlocked = () => {
  const out = [];
  let cur = new Array(BLOCK);
  let nxt = new Array(BLOCK);

  for (let base = 0; base < starts.length; base += BLOCK) {
    const end = Math.min(base + BLOCK, starts.length);
    let curLen = 0;

    for (let i = base; i < end; i += 1) {
      cur[curLen] = starts[i];
      curLen += 1;
    }

    for (let level = 0; level < DEPTH; level += 1) {
      const emitting = level + 1 === DEPTH;
      let nxtLen = 0;

      for (let i = 0; i < curLen; i += 1) {
        const bucket = step(cur[i]);

        if (bucket === undefined) {
          continue;
        }

        for (const e of bucket) {
          const w = e.to;

          if (emitting) {
            out.push(w.properties.k);
          } else {
            // The buffer grows only if a level fans out past BLOCK; at out-degree 1 it never does,
            // and `nxt.length` is read rather than assumed so a fan-out fixture stays correct.
            put(nxt, nxtLen, w);
            nxtLen += 1;
          }
        }
      }

      if (emitting) {
        break;
      }

      const swap = cur;

      cur = nxt;
      nxt = swap;
      curLen = nxtLen;
    }
  }

  return out;
};

const ARMS = {
  dfs: runDfs,
  level: () => runLevel(false),
  sorted: () => runLevel(true),
  blocked: runBlocked,
};

/**
 * ⚠️ ANSWER EQUIVALENCE FIRST, AND AS A MULTISET. Row order is unspecified (item 198) and these arms
 * deliberately produce different orders, so the comparison sorts. A timing from an arm that answers
 * a different question is meaningless, which is the whole reason this runs before the clock.
 */
const canon = (rows) => {
  const c = [...rows].sort((a, b) => a - b);

  return `${c.length}:${c.slice(0, 12).join(',')}:${c.slice(-12).join(',')}`;
};

const base = canon(ARMS.dfs());

for (const [name, fn] of Object.entries(ARMS)) {
  const got = canon(fn());

  if (got !== base) {
    throw new Error(
      `arm ${name} is NOT answer-equivalent to dfs:\n  dfs    ${base}\n  ${name} ${got}`,
    );
  }
}

const results = {};

for (const [name, fn] of Object.entries(ARMS)) {
  for (let r = 0; r < 3; r += 1) {
    fn();
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = fn();

    series.push(performance.now() - t0);

    if (rows.length === 0) {
      throw new Error(`arm ${name} returned no rows`);
    }
  }

  const sorted = [...series].sort((a, b) => a - b);

  results[name] = {
    ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

console.log(
  JSON.stringify({
    depth: DEPTH,
    nodes: NODES,
    stride: STRIDE,
    reps: REPS,
    rows: ARMS.dfs().length,
    arms: results,
    block: BLOCK,
    restructuring: Number((results.dfs.ms / results.level.ms).toFixed(3)),
    ordering: Number((results.level.ms / results.sorted.ms).toFixed(3)),
    total: Number((results.dfs.ms / results.sorted.ms).toFixed(3)),
    blocked: Number((results.dfs.ms / results.blocked.ms).toFixed(3)),
  }),
);
