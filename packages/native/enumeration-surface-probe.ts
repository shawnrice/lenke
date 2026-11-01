/**
 * What does the UNWIRED pinned chain actually enumerate?
 *
 * The narrow spy wrapped only `verticesById.values()`. At 200k the unwired arm costs 12.4 ms and
 * pulls ZERO there, so it walks something else. Every enumeration surface on both vertex indexes
 * is counted here, plus the `vertices` getter, so the answer is read rather than guessed.
 *
 * SPY_N=200000 SHAPE=pinned3  — one shape per process, as `pinned-chain-count-probe.ts` does.
 *
 * GENERAL LESSON, worth more than the item it was built for: a spy on ONE enumeration surface that
 * reads zero has NOT shown there is nothing to find. Item 1329's narrow spy watched
 * `verticesById.values()`, read 0 for both arms at 2k/8k/50k/200k, and was believed — it was the
 * wrong surface, and the swept route was walking the label index all along. Point this at a route
 * before asserting anything about which one was taken.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.SPY_N ?? 200_000);
const SHAPE = process.env.SHAPE ?? 'pinned3';

const counts = new Map<string, number>();
const bump = (k: string, by = 1): void => {
  counts.set(k, (counts.get(k) ?? 0) + by);
};

const countedIter = <T>(inner: Iterator<T>, key: string): IterableIterator<T> =>
  ({
    [Symbol.iterator]() {
      return this;
    },
    next() {
      const s = inner.next();

      if (!s.done) {
        bump(key);
      }

      return s;
    },
  }) as unknown as IterableIterator<T>;

const wrapMap = <V>(m: Map<string, V>, label: string): void => {
  const realValues = m.values.bind(m);
  const realKeys = m.keys.bind(m);
  const realEntries = m.entries.bind(m);
  const realForEach = m.forEach.bind(m);
  const realIter = m[Symbol.iterator].bind(m);
  const realGet = m.get.bind(m);

  m.values = (() => countedIter(realValues(), `${label}.values`)) as unknown as typeof m.values;
  m.keys = (() => countedIter(realKeys(), `${label}.keys`)) as unknown as typeof m.keys;
  m.entries = (() => countedIter(realEntries(), `${label}.entries`)) as unknown as typeof m.entries;
  (m as unknown as { [Symbol.iterator]: () => unknown })[Symbol.iterator] = () =>
    countedIter(realIter(), `${label}.iter`);

  m.forEach = (cb: (v: V, k: string, mm: Map<string, V>) => void, thisArg?: unknown): void => {
    realForEach((v, k, mm) => {
      bump(`${label}.forEach`);
      cb.call(thisArg, v, k, mm);
    });
  };

  m.get = (k: string) => {
    bump(`${label}.get`, 0);

    const got = realGet(k);

    if (got instanceof Set) {
      const s = got as unknown as Set<unknown>;
      const sValues = s.values.bind(s);
      const sIter = s[Symbol.iterator].bind(s);
      const sForEach = s.forEach.bind(s);

      s.values = (() =>
        countedIter(sValues(), `${label}[set].values`)) as unknown as typeof s.values;
      (s as unknown as { [Symbol.iterator]: () => unknown })[Symbol.iterator] = () =>
        countedIter(sIter(), `${label}[set].iter`);

      s.forEach = (cb: (v: unknown, v2: unknown, ss: Set<unknown>) => void, thisArg?: unknown) =>
        sForEach((v, v2, ss) => {
          bump(`${label}[set].forEach`);
          cb.call(thisArg, v, v2, ss);
        });
    }

    return got;
  };
};

const chain = (hops: number): string =>
  Array.from({ length: hops }, (_, i) => `-[:E]->(n${i})`).join('');

const SHAPES: Record<string, { q: string; p: Record<string, unknown> }> = {
  pinned3: {
    q: `MATCH (a:P)${chain(3)} WHERE element_id(a) = $id RETURN count(*) AS c`,
    p: { id: 'v7' },
  },
  endgate3: { q: `MATCH (a:P)${chain(3)} WHERE n2.k = 7 RETURN count(*) AS c`, p: {} },
  bare3: { q: `MATCH (a:P)${chain(3)} RETURN count(*) AS c`, p: {} },
};

const shape = SHAPES[SHAPE];

if (!shape) {
  console.log(`arms: ${Object.keys(SHAPES).join(' ')}`);
  process.exit(2);
}

const g = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
);

for (let i = 0; i < N; i++) {
  g.addEdge({ id: `e${i}`, from: vs[i], to: vs[(i * 7 + 1) % N], labels: ['E'], properties: {} });
}

wrapMap(g.verticesById, 'byId');
wrapMap(g.verticesByLabel, 'byLabel');

const t0 = performance.now();
const rows = query(g, shape.q, shape.p);
const ms = performance.now() - t0;

console.log(`SHAPE=${SHAPE} N=${N} answer=${Number(rows[0]?.c)} first-rep=${ms.toFixed(3)} ms`);

const hot = [...counts.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

console.log(hot.length ? hot.map(([k, v]) => `${k}=${v}`).join('  ') : 'NOTHING ENUMERATED');
