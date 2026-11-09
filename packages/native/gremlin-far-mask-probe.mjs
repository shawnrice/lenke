/**
 * WHAT WOULD A PER-VERTEX ACCEPT MASK BE WORTH TO A FAR-FILTERED GREMLIN WALK?
 *
 * `V().out().has(age, eq(30)).id()` is the widest TS-vs-native ratio of any yielding row in
 * `bun run bench:gremlin` — TS 159.7 ms against native 2.69. The audit records that as OPEN and
 * "ALGORITHMIC (native seeks; TS scans every edge), not a closure-overhead one", with only ~1.4x of
 * TS-side headroom left against a hand floor.
 *
 * ⚠️ THE "NATIVE SEEKS" HALF OF THAT IS WRONG, AND CHECKING IT IS WHY THIS PROBE EXISTS: there is no
 * `createIndex` anywhere in the Gremlin bench, so native has no index to seek. What native has is
 * COLUMNAR properties, which lets it test the predicate once per VERTEX and then test a bit per
 * edge. TS tests it once per EDGE.
 *
 * At 200,000 vertices and 1,000,000 edges the far node is reached ~5 times on average, so the
 * per-edge form does ~5x the predicate work the question needs. That is the same per-vertex-versus-
 * per-arrival lever items 1689 and 1690 took in GQL.
 *
 * Arms, all asserted to the same multiset of ids (SORTED, because row order is unspecified here):
 *
 *   engine        the real traversal, as it runs today
 *   perEdge       a hand-rolled walk testing the predicate per edge — the floor the audit measured
 *   perVertex     the same walk testing it ONCE PER VERTEX into a Uint8Array, then a bit per edge
 *   perVertexCsr  per-vertex mask AND a flat CSR, so the adjacency walk is an Int32Array read
 *
 * The three hand arms separate the two effects: `perEdge` -> `perVertex` is the predicate's cost,
 * `perVertex` -> `perVertexCsr` is the generator chain's.
 *
 * ⚠️ ONE ARM PER PROCESS, AND THE FIRST VERSION OF THIS PROBE WAS NOT. Running all seven arms in one
 * process read the SAME arm at 31.9, 44.2 and 65.6 ms across three runs, and the engine arm between
 * 108.1 and 145.4 — a 2x spread on identical code, wider than several of the differences being
 * compared. `start-filtered-hop-values.ts` records exactly this about the previous probe for this
 * shape, and item 1689 hit it when a four-shape PROFILE named a function the row never enters. So
 * `ARM=<name>` selects one, and the driver runs each in its own process.
 *
 *   ARM=engine node gremlin-far-mask-probe.mjs
 *   ARM=lazyMaskCsr N=200000 node gremlin-far-mask-probe.mjs
 */
import { Graph } from '@lenke/core';
import { eq, has, id, out, toArray, traversal, V } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 14);
const WANT = Number(process.env.WANT ?? 30);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

let e = 0;
const targets = new Set();

for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    const mix = ((i * 2654435761) ^ ((i >> 13) * 40503) ^ (r * 104_729)) & 0x7fffffff;

    targets.add(mix % N);
    g.addEdge({ id: `e${e}`, from: vs[i], to: vs[mix % N], labels: ['KNOWS'], properties: {} });
    e += 1;
  }
}

// ⚠️ The fixture's own statistics, not its output: a degenerate generator returns the RIGHT answer
// (item 1684). A functional graph would make this row a chain rather than a fan-out.
if (targets.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${targets.size} distinct endpoints over ${N} vertices`);
}

const order = [...g.verticesById.values()];

const buildCsr = () => {
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(g.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const edge of order[i].adjFrom?.get('KNOWS') ?? []) {
      nbr[at] = idx.get(edge.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;

  return { off, nbr };
};

const CSR = buildCsr();

/** ⚠️ Per-query: the predicate reads PROPERTIES, so this can never be cached on topology. */
const mask = () => {
  const ok = new Uint8Array(order.length);

  for (let s = 0; s < order.length; s += 1) {
    ok[s] = order[s].properties.age === WANT ? 1 : 0;
  }

  return ok;
};

const MASK = mask();

// `traversal(...)` builds a PLAN; `toArray(plan, graph)` runs it — the bench's own convention.
const PLAN = traversal(V(), out('KNOWS'), has('age', eq(WANT)), id());

/** The predicate once per EDGE — the shape the walk has today. */
const perEdge = () => {
  const out_ = [];

  for (const v of order) {
    for (const edge of v.adjFrom?.get('KNOWS') ?? []) {
      const far = edge.to;

      if (far.properties.age === WANT) {
        out_.push(far.id);
      }
    }
  }

  return out_;
};

/** The predicate once per VERTEX, then one array read per edge. */
const perVertex = () => {
  const ok = mask();
  const out_ = [];
  const idxOf = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idxOf.set(order[i], i);
  }

  for (const v of order) {
    for (const edge of v.adjFrom?.get('KNOWS') ?? []) {
      const far = edge.to;

      if (ok[idxOf.get(far)] === 1) {
        out_.push(far.id);
      }
    }
  }

  return out_;
};

/** Per-vertex mask AND a flat CSR: no generator frame, no map lookup per edge. */
const perVertexCsr = ({ off, nbr }, ok) => {
  const out_ = [];

  for (let s = 0; s < order.length; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      const far = nbr[i];

      if (ok[far] === 1) {
        out_.push(order[far].id);
      }
    }
  }

  return out_;
};

/**
 * ⚠️ THE ARM THAT DECOMPOSES THE WIN: a flat CSR walk with the predicate still PER EDGE. Without it,
 * `perVertex` -> `perVertexCsr` conflates two changes, and `perVertex` additionally pays an
 * `idxOf.get(far)` per edge that `perEdge` does not — so the mask arm is handicapped and the CSR arm
 * flattered. This one isolates the adjacency representation from the predicate's placement.
 */
const perEdgeCsr = ({ off, nbr }) => {
  const out_ = [];

  for (let s = 0; s < order.length; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      const far = order[nbr[i]];

      if (far.properties.age === WANT) {
        out_.push(far.id);
      }
    }
  }

  return out_;
};

/**
 * ⚠️ THE ARM THAT WOULD ACTUALLY SHIP: the mask resolved LAZILY on first arrival, not eagerly over
 * all V. Item 1689 learned why from a near-miss: a predicate can THROW (a string-vs-temporal `<=`
 * does, settled policy here), so gating every vertex raises errors on vertices the walk never
 * reaches. Lazy resolution keeps the EVALUATED SET exactly the walk's — every far vertex reached by
 * an edge, and no other — and changes only how OFTEN each is tested.
 *
 * It costs one extra branch per edge against `perVertexCsr`, so the gap between them is the price of
 * that correctness, and it is the number the build should be judged against.
 */
const lazyMaskCsr = ({ off, nbr }) => {
  const n = order.length;
  const accept = new Uint8Array(n);
  const state = new Uint8Array(n);
  const out_ = [];

  for (let s = 0; s < n; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      const far = nbr[i];

      if (state[far] === 0) {
        state[far] = 1;
        accept[far] = order[far].properties.age === WANT ? 1 : 0;
      }

      if (accept[far] === 1) {
        out_.push(order[far].id);
      }
    }
  }

  return out_;
};

/**
 * ⚠️ THE FORM THAT KEEPS THE WALK'S EVALUATED SET *AND* STAYS TIGHT: mark, resolve, emit.
 *
 * `lazyMaskCsr` resolves on first arrival, which is semantically right — the walk tests exactly the
 * far vertices an edge reaches — but it puts a branch and a property read INSIDE the hot loop and
 * measured 22.17 ms against an eager mask's 3.11. Splitting it into three passes keeps every loop
 * monomorphic:
 *
 *   1. mark   which slots an edge reaches          (1M Int32Array reads, nothing else)
 *   2. resolve the predicate for MARKED slots only (<=V property reads — the walk's own set)
 *   3. emit   the accepted arrivals                (1M reads)
 *
 * Two passes over `nbr` instead of one, which is the trade: array reads are cheap and the property
 * read is not.
 */
const markThenMask = ({ off, nbr }) => {
  const n = order.length;
  const reached = new Uint8Array(n);
  const accept = new Uint8Array(n);
  const total = off[n];

  for (let i = 0; i < total; i += 1) {
    reached[nbr[i]] = 1;
  }

  for (let s = 0; s < n; s += 1) {
    if (reached[s] === 1 && order[s].properties.age === WANT) {
      accept[s] = 1;
    }
  }

  const out_ = [];

  for (let s = 0; s < n; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      const far = nbr[i];

      if (accept[far] === 1) {
        out_.push(order[far].id);
      }
    }
  }

  return out_;
};

const ARMS = {
  engine: () => toArray(PLAN, g),
  markThenMask: () => markThenMask(CSR),
  lazyMaskCsr: () => lazyMaskCsr(CSR),
  perEdge,
  perVertex,
  perEdgeCsr: () => perEdgeCsr(CSR),
  perVertexCsr: () => perVertexCsr(CSR, MASK),
  /**
   * ⚠️ THE HONEST EAGER ARM, AND THE REASON IT EXISTS IS AN ERROR IN THIS FILE. `perVertexCsr`
   * above reuses `MASK`, built ONCE at module scope — so it excludes all 200,000 property reads and
   * reported 80-91x. That is the same class of mistake as timing a warm cache against a cold one,
   * and it nominated a target that does not exist at that size. This arm builds the mask INSIDE the
   * timed region, which is what any shipped route must do: the mask reads properties, and a property
   * write does not bump `topologyVersion`, so it can never be cached across queries.
   */
  perVertexCsrPlusMask: () => perVertexCsr(CSR, mask()),
};

// ⚠️ ROW ORDER IS UNSPECIFIED for an unordered traversal, so the arms are compared as SORTED
// multisets — sorting to fake agreement would be wrong, comparing sorted copies is not. The ENGINE
// arm is the oracle and is always run once, even when another arm is being timed: an arm whose
// answer was never checked is not a measurement of the same question.
const canon = (xs) => [...xs].map(String).sort().join(',');
const want = canon(ARMS.engine());

if (want.length === 0) {
  throw new Error('the engine arm returned nothing — the row proves nothing');
}

const PICK = process.env.ARM;

if (PICK === undefined || ARMS[PICK] === undefined) {
  throw new Error(`set ARM to one of: ${Object.keys(ARMS).join(', ')}`);
}

const got = canon(ARMS[PICK]());

if (got !== want) {
  throw new Error(`ARM ${PICK} DISAGREES with the engine`);
}

/** ⚠️ MEDIAN of the warm reps, not min: the TS per-row path plateaus and emits a rare fast rep. */
const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  ARMS[PICK]();
  series.push(performance.now() - t0);
}

const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${PICK.padEnd(22)} median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(8)} min=${Math.min(
    ...series,
  )
    .toFixed(2)
    .padStart(
      8,
    )} rows=${want.split(',').length} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
