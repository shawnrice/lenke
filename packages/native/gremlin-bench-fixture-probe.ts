/**
 * WHY DOES `V().out().id()` READ 207.6 ms IN `bench:gremlin` AND 61.06 IN A STANDALONE PROBE?
 *
 * The same traversal, 3.4x apart (item 1693). This matters more than either number: the bench's
 * ranking is what nominates every target, so a systematic distortion in it has been steering target
 * selection for this whole session.
 *
 * Four candidate causes, and this probe isolates them ONE AT A TIME by using the bench's OWN fixture
 * (byte-for-byte its NDJSON and its loader) and running ONE shape per process:
 *
 *   1. the MULTI-SHAPE PROCESS — the bench runs 31 plans through one `toArray` call site, which
 *      makes it megamorphic. `start-filtered-hop-values.ts` records this exact trap for a previous
 *      probe ("`pick` is called through a closure VARIABLE … several arms in one process make that
 *      call site polymorphic"), and item 1691 measured a 2x spread from it.
 *   2. the LOADER — the bench deserializes NDJSON; the standalone probe calls `addVertex`/`addEdge`.
 *   3. EDGE PROPERTIES — the bench's edges carry `w`; the probe's are `{}`.
 *   4. the DEGREE DISTRIBUTION — the bench gives every vertex exactly 5 out-edges; the probe varies
 *      1..9 with the same mean.
 *
 * ARM=one   the bench fixture, ONE shape, one process      -> isolates (1)
 * ARM=many  the bench fixture, all four shapes in order    -> reproduces (1) if it is the cause
 *
 *   ARM=one bun gremlin-bench-fixture-probe.ts
 */
import { Graph } from '@lenke/core';
import { V, id, out, toArray, traversal, values } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

const N = Number(process.env.PROBE_N ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);

// ⚠️ BYTE-FOR-BYTE `bench-gremlin.ts`'s fixture, including the repeat-index split that item 1632 put
// in to stop the graph being functional, and the edge property `w` the standalone probe omits.
const lines = Array.from(
  { length: N },
  (_, i) => `{"type":"node","id":"v${i}","labels":["Person"],"properties":{"age":${i % 90}}}`,
);

for (let k = 0; k < N * 5; k++) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  lines.push(
    `{"type":"edge","id":"e${k}","labels":["KNOWS"],"from":"v${(k * 7919) % N}","to":"v${to}","properties":{"w":${k % 7}}}`,
  );
}

// ⚠️ THE BENCH'S OWN TS LOADER. `graphFromNdjson` is the NATIVE one (it takes a backend), which
// is what the first version of this probe reached for — the two loaders live one import apart.
/**
 * ⚠️ FOUR WAYS TO BUILD THE SAME GRAPH, so the fixture's 2.44x can be attributed. The one-shape arm
 * on the bench's own fixture reads 149.03 ms where a standalone probe read 61.06, and the remaining
 * differences between them are exactly these three: the LOADER, the EDGE PROPERTY `w`, and the
 * degree distribution (exactly 5 against 1..9 with the same mean).
 *
 *   FIXTURE=ndjson     the bench's: deserialized, edges carry `w`, degree exactly 5
 *   FIXTURE=api        the same values via addVertex/addEdge     -> isolates the LOADER
 *   FIXTURE=noprops    deserialized, edges carry NO properties   -> isolates `w`
 *   FIXTURE=vardeg     deserialized with degree 1..9             -> isolates the distribution
 */
/**
 * ⚠️ THE SAME EDGE SET, INSERTED GROUPED BY SOURCE. The bench's `from = (k * 7919) % N` scatters a
 * vertex's five edges ~200,000 insertions apart, so its `Edge` objects land far apart in allocation
 * order and walking one vertex's adjacency chases pointers across the heap. Grouping them changes
 * nothing about the graph — same vertices, same edges, same per-vertex bucket ORDER, so the emitted
 * sequence is identical — only the LAYOUT.
 *
 * If this reads near the standalone probe's 61 ms while the scattered build reads ~145, then the
 * fixture's 2.44x is LOCALITY, and the bench is measuring a cache-hostile adjacency the standalone
 * probe never had.
 */
const buildGrouped = (): Graph => {
  const h = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(h.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
  }

  // Bucket the bench's edges by source first, then insert source by source.
  const bySource: number[][] = Array.from({ length: N }, () => []);

  for (let k = 0; k < N * 5; k += 1) {
    bySource[(k * 7919) % N].push(k);
  }

  let e = 0;

  for (let from = 0; from < N; from += 1) {
    for (const k of bySource[from]) {
      const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

      h.addEdge({
        id: `e${e}`,
        from: vs[from],
        to: vs[to],
        labels: ['KNOWS'],
        properties: { w: k % 7 },
      });
      e += 1;
    }
  }

  return h;
};

const buildApi = (withProps: boolean, varDeg: boolean): Graph => {
  const h = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(h.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
  }

  let e = 0;

  for (let k = 0; k < N * 5; k += 1) {
    const from = (k * 7919) % N;

    if (varDeg && k % 9 > 4) {
      continue;
    }

    const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

    h.addEdge({
      id: `e${e}`,
      from: vs[from],
      to: vs[to],
      labels: ['KNOWS'],
      properties: withProps ? { w: k % 7 } : {},
    });
    e += 1;
  }

  return h;
};

const FIXTURE = process.env.FIXTURE ?? 'ndjson';
const ndjsonOf = (withProps: boolean): string => {
  if (withProps) {
    return lines.join('\n');
  }

  return lines.map((l) => l.replace(/,"properties":\{"w":\d+\}/, ',"properties":{}')).join('\n');
};
const buildFixture = (): Graph => {
  switch (FIXTURE) {
    case 'api':
      return buildApi(true, false);
    case 'grouped':
      return buildGrouped();
    case 'noprops':
      return tsDeserialize(ndjsonOf(false), 'ndjson', new Graph());
    case 'vardeg':
      return buildApi(true, true);
    default:
      return tsDeserialize(lines.join('\n'), 'ndjson', new Graph());
  }
};
const g: Graph = buildFixture();

// The fixture's own statistics, as CLAUDE.md requires before any number from it is believed.
const distinct = new Set<unknown>();

for (const e of g.edges) {
  distinct.add(e.to);
}

if (distinct.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${distinct.size} distinct endpoints over ${N} vertices`);
}

const SHAPES = {
  id: traversal(V(), out('KNOWS'), id()),
  values: traversal(V(), out('KNOWS'), values('age')),
  bare: traversal(V(), out('KNOWS')),
  count: traversal(V(), out('KNOWS'), values('age')),
};

const timed = (plan: (typeof SHAPES)['id']): { med: number; series: number[]; rows: number } => {
  const series: number[] = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = toArray(plan, g).length;
    series.push(performance.now() - t0);
  }

  const warm = [...series].slice(3).sort((a, b) => a - b);

  return { med: warm[Math.floor(warm.length / 2)], series, rows };
};

/**
 * ⚠️ THE HAND ARMS, ON WHICHEVER FIXTURE IS SELECTED. Item 1693 refuted a CSR drain for this walk at
 * 1.58x warm and 0.76x cold — measured on a GROUPED-insertion fixture, which is the best case for a
 * pointer-chasing walk and therefore the worst case for the lever. The bench's scattered layout is
 * 2.26x slower for the same graph, so the refutation has to be re-run against it.
 */
const order = [...g.verticesById.values()];

const buildCsr = (): { off: Int32Array; nbr: Int32Array } => {
  const idx = new Map<unknown, number>();

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

const handGen = (): unknown[] => {
  const acc: unknown[] = [];

  for (const v of order) {
    for (const edge of v.adjFrom?.get('KNOWS') ?? []) {
      acc.push(edge.to.id);
    }
  }

  return acc;
};

const handCsr = ({ off, nbr }: { off: Int32Array; nbr: Int32Array }): unknown[] => {
  const acc: unknown[] = [];

  for (let s = 0; s < order.length; s += 1) {
    const end = off[s + 1];

    for (let i = off[s]; i < end; i += 1) {
      acc.push(order[nbr[i]].id);
    }
  }

  return acc;
};

const HAND = {
  handGen,
  handCsr: (() => {
    const csr = buildCsr();

    return () => handCsr(csr);
  })(),
  handCsrPlusBuild: () => handCsr(buildCsr()),
};

const timedFn = (fn: () => unknown[]): { med: number; series: number[]; rows: number } => {
  const series: number[] = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = fn().length;
    series.push(performance.now() - t0);
  }

  const warm = [...series].slice(3).sort((a, b) => a - b);

  return { med: warm[Math.floor(warm.length / 2)], series, rows };
};

const ARM = process.env.ARM ?? 'one';

if (ARM in HAND) {
  const want = toArray(SHAPES.id, g);
  const got = HAND[ARM as keyof typeof HAND]();

  if (got.length !== want.length) {
    throw new Error(`ARM ${ARM}: ${got.length} rows against the engine's ${want.length}`);
  }

  // Gremlin order is a CONTRACT compared ordered by the fuzzer, so the hand arm must match the
  // SEQUENCE, not the multiset.
  for (let i = 0; i < want.length; i += 1) {
    if (got[i] !== want[i]) {
      throw new Error(`ARM ${ARM} diverges at row ${i}`);
    }
  }

  const { med, series, rows } = timedFn(HAND[ARM as keyof typeof HAND]);

  console.log(
    `${ARM.padEnd(18)} median=${med.toFixed(2)} rows=${rows} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
  );
  process.exit(0);
}

if (ARM === 'one') {
  const { med, series, rows } = timed(SHAPES.id);

  console.log(
    `ONE-SHAPE  id  median=${med.toFixed(2)} rows=${rows} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
  );
} else {
  // ⚠️ THE SAME `toArray` CALL SITE SERVING SEVERAL PLANS, which is what the bench does. If this
  // reproduces the bench's figure while the one-shape arm does not, the bench's numbers carry a
  // polymorphism tax and its RANKING is what needs correcting, not the engine.
  for (const [name, plan] of Object.entries(SHAPES)) {
    const { med, rows } = timed(plan);

    console.log(`MANY-SHAPE ${name.padEnd(7)} median=${med.toFixed(2)} rows=${rows}`);
  }
}
