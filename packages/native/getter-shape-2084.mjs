/*
 * Item 2084 — is the `properties` getter's cost its THREE private-field reads, or the getter call?
 *
 * ⚠️ THE BIG FIX IS DISQUALIFIED, so this prices the small one. Caching `box.bag` in a private field
 * would cut the steady state to one read — but `box.bag = frozen` IS reassigned by the properties
 * setter, and boxes are SHARED BY ID across elements, so a cached bag goes stale when a DIFFERENT
 * element with the same id writes. Same shape as the label-index-vs-setter wrong answer.
 *
 * So the only safe change is removing the redundant third private read. These arms price that alone.
 */
const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 14);

class ThreeReads {
  #graph;
  #box;
  #id;

  constructor(graph, id) {
    this.#graph = graph;
    this.#id = id;
    this.#box = undefined;
  }

  // The shape in `Vertex.ts` today: #graph, then #box twice.
  get properties() {
    if (!this.#graph) {
      return {};
    }

    this.#box ??= this.#graph.elementProperties.get(this.#id);

    return this.#box?.bag ?? {};
  }
}

class OneRead {
  #graph;
  #box;
  #id;

  constructor(graph, id) {
    this.#graph = graph;
    this.#id = id;
    this.#box = undefined;
  }

  // ⚠️ `box` IS STILL READ FRESH FROM THE BOX EVERY CALL — only the duplicate #box read is gone, so
  // a reassigned `box.bag` is still seen. This is the change that cannot go stale.
  get properties() {
    const graph = this.#graph;

    if (!graph) {
      return {};
    }

    let box = this.#box;

    if (box === undefined) {
      box = graph.elementProperties.get(this.#id);
      this.#box = box;
    }

    return box?.bag ?? {};
  }
}

class PlainField {
  constructor(bag) {
    this.properties = bag;
  }
}

const graph = { elementProperties: new Map() };
const three = new Array(N);
const one = new Array(N);
const plain = new Array(N);

for (let i = 0; i < N; i++) {
  const bag = { n: i };

  graph.elementProperties.set(`v${i}`, { bag, keys: undefined });
  three[i] = new ThreeReads(graph, `v${i}`);
  one[i] = new OneRead(graph, `v${i}`);
  plain[i] = new PlainField(bag);
}

const walk = (source) => () => {
  let sum = 0;

  for (const v of source) {
    sum += v.properties.n;
  }

  return sum;
};

const arms = {
  three: walk(three),
  one: walk(one),
  plain: walk(plain),
};

const arm = process.env.ARM;

if (!(arm in arms)) {
  throw new Error(`ARM must be one of ${Object.keys(arms).join(', ')} — got ${String(arm)}`);
}

// ⚠️ WARM THE BOX CACHE FIRST. The first read per element populates `#box`, so an unwarmed run prices
// 200,000 Map lookups that the engine pays once and then never again.
arms[arm]();

const series = [];
let out;

for (let r = 0; r < REPS; r++) {
  const t0 = performance.now();

  out = arms[arm]();
  series.push(performance.now() - t0);
}

const expect = (N * (N - 1)) / 2;

if (out !== expect) {
  throw new Error(`${arm} answered ${out}, expected ${expect} — arms not equivalent`);
}

const kept = series.slice(3).sort((a, b) => a - b);
const median = kept[Math.floor(kept.length / 2)];

console.log(
  `${arm.padEnd(6)} median=${median.toFixed(3)} ms  ${((median * 1e6) / N).toFixed(2)} ns/row  series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
