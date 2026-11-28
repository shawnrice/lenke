import { Graph } from '@lenke/core';

import { query } from './src/index.ts';

/*
 * Item 2490: does the GQL surface share item 2488's missing-key defect? **No — it is ISO-correct on
 * all 13 rows**, which means the two surfaces of this one engine DISAGREE with each other.
 *
 * THE ORACLE HERE IS ISO, NOT A CONSOLE. There is no GQL console to run; the rule is ISO/IEC
 * 39075's three-valued logic — a comparison with NULL evaluates to UNKNOWN, and a `WHERE` keeps only
 * rows where the condition is TRUE, so a vertex lacking the key is excluded from BOTH `k = 'x'` and
 * `k <> 'x'`. The repo's own `filter-order-is-unobservable` note records the same thing from the
 * implementation side: a FILTER keeps only clean TRUE, so UNKNOWN settles out.
 *
 * THE FIXTURE IS SPARSE ON PURPOSE: only `a` and `b` carry `k`; `c` and `d` lack it entirely. Item
 * 2483's rule — an arm whose expected value coincides with the control's is not evidence — and a
 * dense fixture would make every row below agree for the wrong reason.
 */
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 'a', k: 'x' } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 'b', k: 'y' } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { n: 'c' } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { n: 'd' } });

  return g;
};

const g = build();

const run1 = (src: string): string => {
  try {
    return (
      query(g, src)
        .map((r) => String(Object.values(r)[0]))
        .sort()
        .join(',') || '(empty)'
    );
  } catch (e) {
    return `THROWS: ${String((e as Error)?.message ?? e).slice(0, 30)}`;
  }
};

const rows: Array<[string, string, string]> = [
  ['G01 k = x', "MATCH (v:P) WHERE v.k = 'x' RETURN v.n AS n", 'a'],
  // THE ROW THE GREMLIN SURFACE GETS WRONG (items 2488/2489): `has('k', neq('x'))` there returns
  // b,c,d. ISO excludes c and d because `NULL <> 'x'` is UNKNOWN, not TRUE.
  ['G02 k <> x', "MATCH (v:P) WHERE v.k <> 'x' RETURN v.n AS n", 'b'],
  // `NOT UNKNOWN` is UNKNOWN, so negating the comparison does NOT admit absence — unlike TinkerPop's
  // `not(has(...))`, which is a TRAVERSAL negation ("the inner traversal produced nothing") and does.
  // Different constructs, not a contradiction; G10 is GQL's spelling of the traversal form.
  ['G03 NOT (k = x)', "MATCH (v:P) WHERE NOT (v.k = 'x') RETURN v.n AS n", 'b'],
  ['G04 k IS NULL', 'MATCH (v:P) WHERE v.k IS NULL RETURN v.n AS n', 'c,d'],
  ['G05 k IS NOT NULL', 'MATCH (v:P) WHERE v.k IS NOT NULL RETURN v.n AS n', 'a,b'],
  ['G06 k > w', "MATCH (v:P) WHERE v.k > 'w' RETURN v.n AS n", 'a,b'],
  ['G07 k IN [x]', "MATCH (v:P) WHERE v.k IN ['x'] RETURN v.n AS n", 'a'],
  ['G08 NOT (k IN [x])', "MATCH (v:P) WHERE NOT (v.k IN ['x']) RETURN v.n AS n", 'b'],
  ['G09 no WHERE', 'MATCH (v:P) RETURN v.n AS n', 'a,b,c,d'],
  // GQL CAN express the "lacks the key OR differs" meaning — the one TinkerPop spells
  // `not(has(k, eq(v)))`. So both surfaces have both meanings available; only lenke's Gremlin
  // collapses them onto this one.
  ['G10 IS NULL OR k <> x', "MATCH (v:P) WHERE v.k IS NULL OR v.k <> 'x' RETURN v.n AS n", 'b,c,d'],
  ['G11 NOT PROPERTY_EXISTS', 'MATCH (v:P) WHERE NOT PROPERTY_EXISTS(v, k) RETURN v.n AS n', 'c,d'],
  // UNKNOWN propagation: UNKNOWN AND TRUE is UNKNOWN (filtered); UNKNOWN OR TRUE is TRUE (kept).
  ['G12 UNKNOWN in AND', "MATCH (v:P) WHERE v.k <> 'x' AND v.n <> 'zz' RETURN v.n AS n", 'b'],
  ['G13 UNKNOWN in OR', "MATCH (v:P) WHERE v.k = 'x' OR v.n = 'c' RETURN v.n AS n", 'a,c'],
];

let agreed = 0;
let disagreed = 0;

for (const [label, src, iso] of rows) {
  const got = run1(src);
  const verdict = got === iso ? 'agree' : 'DIFFER';

  if (verdict === 'agree') {
    agreed += 1;
  } else {
    disagreed += 1;
  }

  console.log(`  ${label.padEnd(26)} ${verdict.padEnd(6)} lenke=${got.padEnd(14)} ISO=${iso}`);
}

console.log(
  `\n  ${agreed} agree, ${disagreed} DIFFER, of ${rows.length} (oracle: ISO 3VL, no console)`,
);
console.log("  G02 is the row lenke's GREMLIN surface gets wrong — see items 2488/2489.");
