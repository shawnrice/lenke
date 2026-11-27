/**
 * Does the one-hop DISTINCT's PRIMITIVE arm group the hard values exactly as the keyed arm does?
 *
 * Item 2424 replaced a `valueKey` string per element with a raw `Set`, on the argument that the two
 * are equivalent for every primitive. **That argument is the load-bearing claim of the whole item**,
 * and a comment is not a check — `valueKey`'s own notes say it is "THE ONE DEFINITION OF
 * DISTINCTNESS in this engine, shared with `UNION`/`EXCEPT`/`INTERSECT` and matched byte-for-byte by
 * the Rust engine", and `chain-distinct-levels.test.ts` exists because items 1561 and 1562 each
 * shipped a silent answer change in exactly this area.
 *
 * ## THE REFERENCE IS THE ENGINE'S OTHER KEYER, not a re-derivation
 *
 * `count(DISTINCT <expr>)` over the same pattern counts groups through `distinctCount` /
 * `chainFoldLevels`, which key with `valueKey`. So for every fixture:
 *
 *     rows of `RETURN DISTINCT <expr>`   ===   `count(DISTINCT <expr>)`
 *
 * must hold. Two independent code paths, one number — and a raw `Set` that grouped `-0` apart from
 * `0`, or split `NaN`, would make the row count exceed the keyed count. Re-implementing `valueKey`
 * in JS here would have tested this file's idea of distinctness instead of the engine's, which is
 * the mistake item 2416's oracle made with `new Set(objects)` and 96 false failures.
 *
 * ## THE CASES, and why each is on the sheet
 *
 *     -0 vs 0        `valueKey` keys both `n0` (String(-0) is "0"); a `Set` uses SameValueZero,
 *                    where they are already one entry. ONE group either way.
 *     NaN            `#NaN`, and SameValueZero makes NaN equal to itself. ONE group.
 *     Infinity       `#Infinity` / `#-Infinity` — two groups, and distinct in a `Set` too.
 *     null/undefined `N` and `jundefined` — DIFFERENT keys, and distinct in a `Set`. TWO groups,
 *                    even though both render as `null` in the row.
 *     1 vs '1'       type-prefixed (`n1`/`s1`) and `1 !== '1'`. TWO groups.
 *     true/false     `bT`/`bF`. TWO groups.
 *     TEMPORAL       an OBJECT: `valueKey` keys it by its fields, a `Set` by identity. This is the
 *                    case the primitive arm must BAIL on, so it is here to prove the bail works
 *                    rather than that the arm is clever.
 *     LIST           an OBJECT keyed by recursion. Same reason.
 *
 *     bun distinct-hardvalues-2424.ts
 */
import { Graph, type Vertex } from '@lenke/core';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- DELIBERATE: reads SOURCE so a src edit under test is visible without a dist rebuild ([[fuzzers-read-built-dists]]).
import { query } from '../gql/src/index.ts';

/**
 * Each fixture gives the VALUES to place on the far vertices and the number of groups both routes
 * must agree on. The expected count is stated so a fixture that silently stops exercising its case
 * (every value identical, say) fails rather than passing vacuously.
 */
const CASES: { name: string; values: unknown[]; groups: number }[] = [
  { name: '-0 and 0 are ONE group', values: [0, -0, 0, -0], groups: 1 },
  { name: 'NaN is ONE group', values: [Number.NaN, Number.NaN, 1], groups: 2 },
  {
    name: 'Infinity and -Infinity are TWO',
    values: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    groups: 2,
  },
  /*
   * ~~`groups: 2`~~ — ONE, and this fixture CORRECTED MY OWN EXPECTATION rather than finding an
   * engine defect. I predicted two groups from `valueKey`, which keys `null` as `N` and `undefined`
   * as `jundefined`. The engine answers ONE row with a null value, because **reading an ABSENT
   * property yields `null`, not `undefined`** ([[numeric-model-f64]]: undefined is normalized to
   * null), so a property read can never produce `undefined` and `valueKey`'s `jundefined` branch is
   * unreachable from this direction. A stored null and a missing key are the same group.
   *
   * That makes the `undefined` row of item 2424's equivalence table moot rather than wrong: the raw
   * `Set` and `valueKey` agree on `undefined` anyway, and nothing here can hand either of them one.
   */
  {
    name: 'null and an ABSENT property are ONE',
    values: [null, undefined, null, undefined],
    groups: 1,
  },
  { name: "1 and '1' are TWO", values: [1, '1', 1, '1'], groups: 2 },
  { name: 'true and false are TWO', values: [true, false, true], groups: 2 },
  // 0/-0 -> one, NaN -> one, null+absent -> one, '0' -> one, false -> one. FIVE, not six: see the
  // null/absent note above, which is the group I over-counted.
  { name: 'mixed primitives', values: [0, -0, Number.NaN, null, undefined, '0', false], groups: 5 },
  // OBJECTS: the primitive arm must BAIL and the keyed arm must answer.
  {
    name: 'TEMPORAL, equal by VALUE not identity (the bail)',
    values: [{ '@date': '2024-01-01' }, { '@date': '2024-01-01' }, { '@date': '2024-01-02' }],
    groups: 2,
  },
  {
    name: 'LIST, equal by VALUE not identity (the bail)',
    values: [[1, 2], [1, 2], [3]],
    groups: 2,
  },
];

/** `undefined` means "do not write the property at all", which is how a column goes absent. */
const build = (values: readonly unknown[], mixed: boolean): Graph => {
  const g = new Graph();
  const vs: Vertex[] = [];
  const n = values.length;

  for (let i = 0; i < n; i += 1) {
    const v = values[i];

    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        properties: v === undefined ? {} : { c: v },
      }),
    );
  }

  // A COMPLETE graph over the far set, so EVERY value is reached from some start vertex however
  // the walk is driven — a stride could otherwise miss one and the group count would be a fixture
  // artefact rather than a keying fact.
  for (let a = 0; a < n; a += 1) {
    for (let b = 0; b < n; b += 1) {
      g.addEdge({ id: `e${a}-${b}`, from: vs[a], to: vs[b], labels: ['E'], properties: {} });
    }
  }

  if (mixed) {
    g.addVertex({ id: 'off', labels: ['Z'], properties: {} });
  }

  return g;
};

let pass = 0;
const fails: string[] = [];

for (const mixed of [false, true]) {
  const mode = mixed ? 'MIXED' : 'homo';

  for (const c of CASES) {
    const g = build(c.values, mixed);
    const rows = query(g, 'MATCH (a:P)-[:E]->(x:P) RETURN DISTINCT x.c AS v', {}) as unknown as {
      v: unknown;
    }[];
    const counted = query(
      g,
      'MATCH (a:P)-[:E]->(x:P) RETURN count(DISTINCT x.c) AS n',
      {},
    ) as unknown as { n: number }[];
    const n = counted[0]?.n;

    // `count(DISTINCT)` EXCLUDES nulls and the projection KEEPS them, so the two agree on the
    // non-null groups and the projection may carry up to one extra row for null plus one for
    // undefined. Comparing the non-null part is the keying check; `groups` pins the whole shape.
    const nonNull = rows.filter((r) => r.v !== null && r.v !== undefined).length;
    const keyedAgrees = nonNull === n;
    const shapeAgrees = rows.length === c.groups;

    if (keyedAgrees && shapeAgrees) {
      pass += 1;
    } else {
      fails.push(
        `${mode} ${c.name}: DISTINCT gave ${String(rows.length)} rows (${String(nonNull)} non-null), ` +
          `count(DISTINCT) gave ${String(n)}, expected ${String(c.groups)} groups`,
      );
    }
  }
}

console.log(`# DISTINCT hard values: ${String(pass)} pass / ${String(fails.length)} fail`);

for (const f of fails) {
  console.log(`  FAIL ${f}`);
}

if (fails.length > 0) {
  process.exitCode = 1;
}
