import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Query } from './ast.js';
import { compile, parse, query } from './index.js';

/**
 * Metamorphic / property-based fuzzing. Rather than check a random query against
 * a known answer (no oracle), we assert *relationships* between related queries
 * that must hold for any input: boolean-algebra laws under Kleene three-valued
 * logic, cross-feature equivalences (P ⟺ P IS TRUE ⟺ a CASE over P), the
 * EXISTS/COUNT correspondence, compiled-plan agreement, and aggregate identities.
 *
 * The RNG is a seeded mulberry32 so any failure reproduces deterministically —
 * the assertion messages carry the seed and the generated predicates.
 */

const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const PROPS = ['a', 'b', 'c'];

/** A random graph: ~Node vertices with a random subset of {a,b,c}; a few R edges. */
const makeGraph = (rand: () => number): Graph => {
  const g = new Graph();
  g.disableEvents();
  const count = 4 + Math.floor(rand() * 8);
  const nodes = [];

  for (let i = 0; i < count; i += 1) {
    const properties: Record<string, unknown> = {};

    for (const p of PROPS) {
      const r = rand();

      if (r < 0.3) {
        continue; // absent → NULL on access (the interesting case)
      }

      if (r < 0.75) {
        properties[p] = Math.floor(rand() * 5);
      } else {
        properties[p] = rand() < 0.5 ? 'x' : 'y';
      }
    }

    nodes.push(g.addVertex({ id: String(i), labels: ['Node'], properties }));
  }

  const edges = Math.floor(rand() * count);

  for (let i = 0; i < edges; i += 1) {
    const from = nodes[Math.floor(rand() * nodes.length)];
    const to = nodes[Math.floor(rand() * nodes.length)];
    g.addEdge({ from, to, labels: ['R'], properties: {} });
  }

  g.enableEvents();

  return g;
};

const COMP = ['>', '<', '>=', '<=', '=', '<>'];

/** A random leaf predicate over `n`: comparison, IS [NOT] NULL, or [NOT] IN. */
const leaf = (rand: () => number): string => {
  const p = `n.${PROPS[Math.floor(rand() * PROPS.length)]}`;
  const k = rand();

  if (k < 0.55) {
    const op = COMP[Math.floor(rand() * COMP.length)];
    let val: string;

    if (rand() < 0.7) {
      val = String(Math.floor(rand() * 5));
    } else {
      val = rand() < 0.5 ? "'x'" : "'y'";
    }

    return `${p} ${op} ${val}`;
  }

  if (k < 0.78) {
    return `${p} IS ${rand() < 0.5 ? '' : 'NOT '}NULL`;
  }

  const items = [0, 1, 2, 3].filter(() => rand() < 0.5).map(() => String(Math.floor(rand() * 5)));

  return `${p} ${rand() < 0.5 ? '' : 'NOT '}IN [${items.join(', ')}]`;
};

/** A random boolean predicate string built from leaves and AND/OR/XOR/NOT. */
const pred = (rand: () => number, depth: number): string => {
  if (depth <= 0 || rand() < 0.4) {
    return `(${leaf(rand)})`;
  }

  const k = rand();

  if (k < 0.25) {
    return `(NOT ${pred(rand, depth - 1)})`;
  }

  let op = 'XOR';

  if (k < 0.5) {
    op = 'AND';
  } else if (k < 0.75) {
    op = 'OR';
  }

  return `(${pred(rand, depth - 1)} ${op} ${pred(rand, depth - 1)})`;
};

/** The set of node ids kept by `WHERE <predicate>`, sorted for comparison. */
const idsWhere = (g: Graph, predicate: string): string[] =>
  (query(g, `MATCH (n:Node) WHERE ${predicate} RETURN element_id(n) AS id`) as { id: string }[])
    .map((r) => r.id)
    .sort();

const sortedUnion = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort();

const ITERATIONS = 400;

describe('GQL fuzz: Kleene boolean-algebra laws', () => {
  test('OR is the union of trues; De Morgan; AND commutes; NOT involutes', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x5eed_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const P = pred(rand, 3);
      const Q = pred(rand, 3);
      const ctx = `seed=${seed}\nP=${P}\nQ=${Q}`;

      // P OR Q true  ⟺  P true OR Q true.
      expect(idsWhere(g, `${P} OR ${Q}`), `OR≠union\n${ctx}`).toEqual(
        sortedUnion(idsWhere(g, P), idsWhere(g, Q)),
      );
      // De Morgan holds in Kleene logic.
      expect(idsWhere(g, `NOT (${P} AND ${Q})`), `De Morgan\n${ctx}`).toEqual(
        idsWhere(g, `(NOT ${P}) OR (NOT ${Q})`),
      );
      // AND is commutative.
      expect(idsWhere(g, `${P} AND ${Q}`), `AND commute\n${ctx}`).toEqual(
        idsWhere(g, `${Q} AND ${P}`),
      );
      // Double negation.
      expect(idsWhere(g, `NOT (NOT ${P})`), `NOT involute\n${ctx}`).toEqual(idsWhere(g, P));
    }
  });
});

describe('GQL fuzz: feature cross-consistency', () => {
  test('WHERE P ⟺ WHERE (P) IS TRUE ⟺ WHERE CASE over P', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0xca5e_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const P = pred(rand, 3);
      const base = idsWhere(g, P);
      const ctx = `seed=${seed}\nP=${P}`;

      // `P IS TRUE` keeps exactly the rows where P is TRUE.
      expect(idsWhere(g, `(${P}) IS TRUE`), `IS TRUE\n${ctx}`).toEqual(base);
      // A searched CASE collapsing P to a boolean must agree with the filter.
      expect(idsWhere(g, `CASE WHEN ${P} THEN true ELSE false END`), `CASE\n${ctx}`).toEqual(base);
      // `P IS NOT TRUE` is the exact complement.
      const all = idsWhere(g, `n.a = n.a OR true`); // every Node row
      expect(idsWhere(g, `(${P}) IS NOT TRUE`).length, `complement\n${ctx}`).toEqual(
        all.length - base.length,
      );
    }
  });
});

describe('GQL fuzz: EXISTS ⟺ COUNT{} > 0', () => {
  test('the existential and the counted subquery agree', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0xc0_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const ctx = `seed=${seed}`;
      expect(idsWhere(g, `EXISTS { (n)-[:R]->() }`), `EXISTS=COUNT>0\n${ctx}`).toEqual(
        idsWhere(g, `COUNT { (n)-[:R]->() } > 0`),
      );
      expect(idsWhere(g, `NOT EXISTS { (n)-[:R]->() }`), `NOT EXISTS=COUNT=0\n${ctx}`).toEqual(
        idsWhere(g, `COUNT { (n)-[:R]->() } = 0`),
      );
    }
  });
});

describe('GQL fuzz: compiled plan agrees with the one-shot path', () => {
  test('compile(parse(q)) reused matches query(); reuse is stable', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0xc0de_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const P = pred(rand, 3);
      const q = `MATCH (n:Node) WHERE ${P} RETURN element_id(n) AS id ORDER BY id`;
      const ctx = `seed=${seed}\nq=${q}`;
      const oneShot = query(g, q);
      const plan = compile(parse(q) as Query);
      expect(plan(g), `plan≠query\n${ctx}`).toEqual(oneShot);
      expect(plan(g), `plan not stable\n${ctx}`).toEqual(oneShot); // reuse is pure
    }
  });
});

describe('GQL fuzz: aggregate identities', () => {
  test('sum(1) = count(*); count(DISTINCT x) ≤ count(x) ≤ count(*)', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0xa66_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const p = PROPS[Math.floor(rand() * PROPS.length)];
      const row = query(
        g,
        `MATCH (n:Node)
         RETURN sum(1) AS s, count(*) AS star, count(n.${p}) AS nonNull, count(DISTINCT n.${p}) AS dis`,
      )[0] as { s: number; star: number; nonNull: number; dis: number };
      const ctx = `seed=${seed} prop=${p} row=${JSON.stringify(row)}`;
      expect(row.s, `sum(1)=count(*)\n${ctx}`).toEqual(row.star);
      expect(row.dis <= row.nonNull && row.nonNull <= row.star, `count ordering\n${ctx}`).toBe(
        true,
      );
    }
  });
});

describe('GQL fuzz: ORDER BY + SKIP/LIMIT slicing', () => {
  test('SKIP s LIMIT l equals slicing the fully ordered result', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x05d_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const p = PROPS[Math.floor(rand() * PROPS.length)];
      const dir = rand() < 0.5 ? 'ASC' : 'DESC';
      // element_id is a total-order tiebreak so the full order is deterministic.
      const order = `ORDER BY n.${p} ${dir}, element_id(n)`;
      const ids = (q: string): string[] => (query(g, q) as { id: string }[]).map((r) => r.id);
      const full = ids(`MATCH (n:Node) RETURN element_id(n) AS id ${order}`);
      const s = Math.floor(rand() * (full.length + 2));
      const l = Math.floor(rand() * (full.length + 2));
      const sliced = ids(`MATCH (n:Node) RETURN element_id(n) AS id ${order} SKIP ${s} LIMIT ${l}`);
      expect(sliced, `slice seed=${seed}\n${order} SKIP ${s} LIMIT ${l}`).toEqual(
        full.slice(s, s + l),
      );
    }
  });
});

describe('GQL fuzz: set-operation laws', () => {
  test('UNION ALL is additive; EXCEPT self is empty; INTERSECT self is DISTINCT self', () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0x5e7_0000 + i;
      const rand = makeRng(seed);
      const g = makeGraph(rand);
      const A = `MATCH (n:Node) WHERE ${pred(rand, 2)} RETURN element_id(n) AS id`;
      const B = `MATCH (n:Node) WHERE ${pred(rand, 2)} RETURN element_id(n) AS id`;
      const ctx = `seed=${seed}`;
      expect(query(g, `${A} UNION ALL ${B}`).length, `UNION ALL additive\n${ctx}`).toEqual(
        query(g, A).length + query(g, B).length,
      );
      expect(query(g, `${A} EXCEPT ${A}`), `EXCEPT self empty\n${ctx}`).toEqual([]);
      const interSelf = query<{ id: string }>(g, `${A} INTERSECT ${A}`)
        .map((r) => r.id)
        .sort();
      const distinctA = [...new Set(query<{ id: string }>(g, A).map((r) => r.id))].sort();
      expect(interSelf, `INTERSECT self\n${ctx}`).toEqual(distinctA);
    }
  });
});

describe('GQL fuzz: arithmetic precedence matches a reference evaluator', () => {
  // Flat expressions (no parens) where `*` binds tighter than `+`/`-`; the
  // reference value is computed with that precedence, so a parser/precedence or
  // arithmetic bug would diverge.
  const genFlat = (rand: () => number): { str: string; val: number } => {
    const terms: string[] = [];
    const vals: number[] = [];
    const nTerms = 1 + Math.floor(rand() * 3);

    for (let t = 0; t < nTerms; t += 1) {
      const factors: string[] = [];
      let v = 1;
      const nF = 1 + Math.floor(rand() * 3);

      for (let f = 0; f < nF; f += 1) {
        const x = 1 + Math.floor(rand() * 5);
        factors.push(String(x));
        v *= x;
      }

      terms.push(factors.join(' * '));
      vals.push(v);
    }

    let [str] = terms;
    let [val] = vals;

    for (let t = 1; t < nTerms; t += 1) {
      const plus = rand() < 0.5;
      str += (plus ? ' + ' : ' - ') + terms[t];
      val = plus ? val + vals[t] : val - vals[t];
    }

    return { str, val };
  };

  test('random +,-,* expressions evaluate to the precedence-correct value', () => {
    const g = new Graph();

    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = 0xa817_0000 + i;
      const rand = makeRng(seed);
      const { str, val } = genFlat(rand);
      const got = query(g, `RETURN ${str} AS r`)[0].r;
      expect(got, `arith seed=${seed}  ${str}`).toEqual(val);
    }
  });
});
