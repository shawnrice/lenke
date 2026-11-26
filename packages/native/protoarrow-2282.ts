/**
 * **DOES A PROTOTYPE METHOD SURVIVE MULTIPLE INSTANCES WHERE AN ARROW FIELD DOES NOT? (item 2282)**
 *
 * Item 2281 found that `new Graph()` mints a new function object per instance for every arrow-field
 * method, so a call site seeing 9 graphs goes **megamorphic** — 46 ns became 222 ns, 4.8x. With ONE graph
 * there is nothing to fix. But **multiple graphs is a real deployment shape here**: per-tenant or
 * per-room graphs, the NDJSON fork/merge path, and every test file.
 *
 * This is the mechanism in ISOLATION, before touching the engine: two classes identical but for how the
 * method is declared, each measured with 1 instance and with 9 round-robin.
 *
 * If `proto` at 9 instances matches `proto` at 1, the fix is real and the engine can have it. If both
 * declarations degrade equally, the megamorphism is about the RECEIVER's hidden class, not the function
 * object, and converting methods would buy nothing.
 */
const N = 200_000;
const PROBE = 50_000;
const REPS = 11;

const med = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)] ?? 0;
};

class ProtoStore {
  public readonly map: Map<string, { id: string }>;

  public constructor(map: Map<string, { id: string }>) {
    this.map = map;
  }

  /* A PROTOTYPE method: one function object shared by every instance. */
  public getById(id: string): { id: string } | null {
    return this.map.get(id) ?? null;
  }
}

class ArrowStore {
  public readonly map: Map<string, { id: string }>;

  /* An ARROW FIELD: a new function object per instance — what Graph does. */
  public getById = (id: string): { id: string } | null => {
    return this.map.get(id) ?? null;
  };

  public constructor(map: Map<string, { id: string }>) {
    this.map = map;
  }
}

const idOf = (i: number): string => `v${String(i).padStart(7, '0')}`;

/* Every instance gets its OWN map, so the receivers differ as they would in a real multi-graph app. */
const mkMap = (): Map<string, { id: string }> => {
  const m = new Map<string, { id: string }>();

  for (let i = 0; i < N; i += 1) {
    m.set(idOf(i), { id: idOf(i) });
  }

  return m;
};

const maps: Map<string, { id: string }>[] = [];

for (let i = 0; i < 9; i += 1) {
  maps.push(mkMap());
}

const protos = maps.map((m) => new ProtoStore(m));
const arrows = maps.map((m) => new ArrowStore(m));

let s = 0x5eed | 0;
const keys: string[] = [];

for (let i = 0; i < PROBE; i += 1) {
  s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;
  keys.push(idOf((s >>> 1) % N));
}

let sink = 0;

const timeOne = (fn: (k: string, i: number) => unknown): number => {
  const t = performance.now();

  for (let i = 0; i < keys.length; i += 1) {
    if (fn(keys[i], i) !== null) {
      sink += 1;
    }
  }

  return ((performance.now() - t) * 1e6) / PROBE;
};

/* Four separate call sites, so each stays at its own polymorphism level. */
const p1: number[] = [];
const p9: number[] = [];
const a1: number[] = [];
const a9: number[] = [];

const [proto0] = protos;
const [arrow0] = arrows;

for (let rep = 0; rep < REPS; rep += 1) {
  p1.push(timeOne((k) => proto0.getById(k)));
  p9.push(timeOne((k, i) => protos[i % protos.length].getById(k)));
  a1.push(timeOne((k) => arrow0.getById(k)));
  a9.push(timeOne((k, i) => arrows[i % arrows.length].getById(k)));
}

if (sink !== PROBE * REPS * 4) {
  throw new Error(`guard: sink=${sink} expected ${PROBE * REPS * 4}`);
}

const [P1, P9, A1, A9] = [med(p1), med(p9), med(a1), med(a9)];

console.log(`  N=${N}, ${PROBE} lookups, median of ${REPS} (ns/op)`);
console.log(`    prototype method,  1 instance    ${P1.toFixed(1).padStart(7)}`);
console.log(
  `    prototype method,  9 instances   ${P9.toFixed(1).padStart(7)}   ${(P9 / P1).toFixed(2)}x its own 1-instance`,
);
console.log(`    arrow field,       1 instance    ${A1.toFixed(1).padStart(7)}`);
console.log(
  `    arrow field,       9 instances   ${A9.toFixed(1).padStart(7)}   ${(A9 / A1).toFixed(2)}x its own 1-instance`,
);
console.log(`    9-instance proto vs arrow        ${(A9 / P9).toFixed(2)}x   <- the win, if any`);
console.log(`    per-rep proto9: ${p9.map((x) => x.toFixed(0)).join(' ')}`);
console.log(`    per-rep arrow9: ${a9.map((x) => x.toFixed(0)).join(' ')}`);
