import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1502 — auto-parameterization: literals are lifted out of a query's TEXT into parameters so
 * that queries differing only in their constants share one cache entry. Measured on an
 * interpolating caller: **1.46-2.06x** (insert 6708→4596, point 11082→6075, agg 13693→6684,
 * longer 24225→13100 ns).
 *
 * ⚠️ THIS IS A REWRITE OF USER QUERY TEXT, so the risk is not slowness — it is a silent change of
 * meaning. Two halves below, and the first is the one that matters:
 *
 *  1. **The allowlist's REFUSALS**, each tied to the measurement or the semantic fact that put it
 *     there. `normalizeLiterals` is exported for this: the rewrite decision is a pure function, and
 *     a widening that broke a refusal would otherwise be invisible until it produced wrong rows.
 *  2. **Differential answers**: the literal spelling and the lifted spelling must agree, including
 *     for the shapes the allowlist refuses (where "agree" means the query still works at all).
 *
 * The refusals are not stylistic. `{1,3}` is a path QUANTIFIER — lifting its bounds would change
 * the pattern the planner compiles, silently. `LIMIT 10` is read by `topKPlan` at plan time and item
 * 1501 measured a param limit at 5.3-6.1x. `DATE '…'` is a constructor, not a string in a value
 * position. `null` cannot be lifted because `{k: null}` means IS NULL for an inline constraint
 * (item 260) and `IS NULL` has no parameterized spelling at all (item 1501).
 */
import { Graph } from '@lenke/core';

import { normalizeLiterals } from './auto-param.js';
import { query } from './index.js';

describe('what the allowlist LIFTS', () => {
  for (const [name, text] of [
    ['a clause equality', 'MATCH (n:P) WHERE n.k = 7 RETURN n'],
    ['a clause inequality', 'MATCH (n:P) WHERE n.k > 7 RETURN n'],
    ['a clause <=', 'MATCH (n:P) WHERE n.k <= 7 RETURN n'],
    ['a clause <>', 'MATCH (n:P) WHERE n.k <> 7 RETURN n'],
    ['a string', "MATCH (n:P) WHERE n.s = 'abc' RETURN n"],
    ['an inline property', 'MATCH (n:P {k: 7}) RETURN n'],
    ['an inline string property', "MATCH (n:P {s: 'abc'}) RETURN n"],
    ['an INSERT property', "INSERT (:E {name: 'ev', score: 7})"],
    ['a reversed comparison', 'MATCH (n:P) WHERE 7 < n.k RETURN n'],
  ] as const) {
    it(`lifts ${name}`, () => {
      const out = normalizeLiterals(text);

      expect(out, name).toBeDefined();
      expect(Object.keys(out!.params).length).toBeGreaterThan(0);
      // The rewritten text must no longer contain the literal in that position.
      expect(out!.text).toContain('$__ap0');
    });
  }

  it('numbers its parameters in source order and preserves the values', () => {
    const out = normalizeLiterals("MATCH (n:P) WHERE n.k = 7 AND n.s = 'abc' RETURN n");

    expect(out?.params).toEqual({ __ap0: 7, __ap1: 'abc' });
  });

  it('⚠️ uses the DECODED string value, not the source span', () => {
    // A string token's `value` is DECODED, so its source span is longer than its value by the
    // quotes and by every escape — which is why the span is bounded by the next token's `pos` and
    // the VALUE is what goes into the params. Escapes here are backslash-based (doubled quotes are
    // for backtick-delimited identifiers, not strings).
    const out = normalizeLiterals(String.raw`MATCH (n:P) WHERE n.s = 'a\'b' RETURN n`);

    expect(out?.params.__ap0).toBe("a'b");
    expect(out?.text).not.toContain("'");
  });
});

describe('⚠️ what the allowlist REFUSES, and why each one is in the list', () => {
  // ⚠️ EACH ROW ASSERTS ON THE REWRITTEN TEXT, not on the fixture. The first version of this block
  // checked that a refusable token existed in the INPUT and that the query did not throw — a
  // tautology and a near-tautology. Two mutants walked straight through it: widening the allowlist
  // to `lbrace`/`comma` (which lifts PATH QUANTIFIER bounds) and to `keyword` (which lifts `LIMIT`
  // and the temporal constructors) both left all 31 tests green. `mustSurvive` is the fix: the
  // refused token has to still be THERE, in the text the parser will see.
  const mustSurvive = (text: string, fragment: string): void => {
    const out = normalizeLiterals(text);
    const rewritten = out === undefined ? text : out.text;

    expect(rewritten, `"${fragment}" must survive the rewrite`).toContain(fragment);
  };

  it('refuses a path quantifier — lifting a bound changes the pattern the planner compiles', () => {
    mustSurvive('MATCH (a:P)-[:E]->{1,3}(b:P) RETURN b', '{1,3}');
    mustSurvive('MATCH (a:P)-[:E]->{1,3}(b:P) WHERE a.k = 7 RETURN b', '{1,3}');
  });

  it('refuses LIMIT and SKIP — topKPlan reads them at plan time (item 1501: 5.3-6.1x)', () => {
    mustSurvive('MATCH (n:P) RETURN n.k AS v ORDER BY v LIMIT 10', 'LIMIT 10');
    mustSurvive('MATCH (n:P) RETURN n.k AS v ORDER BY v SKIP 5 LIMIT 10', 'SKIP 5');
    mustSurvive('MATCH (n:P) WHERE n.k = 7 RETURN n.k AS v ORDER BY v LIMIT 10', 'LIMIT 10');
  });

  it('refuses a temporal constructor — DATE $p is not the same construct', () => {
    mustSurvive("MATCH (n:P) WHERE n.d > DATE '2020-01-01' RETURN n", "DATE '2020-01-01'");
    mustSurvive(
      "MATCH (n:P) WHERE n.k = 7 AND n.d > DATE '2020-01-01' RETURN n",
      "DATE '2020-01-01'",
    );
  });

  it('refuses list elements, arithmetic and function arguments — conservative, not known unsafe', () => {
    mustSurvive('MATCH (n:P) WHERE n.k IN [7, 8] RETURN n', '[7, 8]');
    mustSurvive('MATCH (n:P) WHERE n.k + 1 = 8 RETURN n', '+ 1');
    mustSurvive('MATCH (n:P) WHERE abs(n.k) = 7 RETURN n', 'abs(n.k)');
  });

  it('declines a literal-free query without rewriting anything', () => {
    expect(normalizeLiterals('MATCH (a:P)-[:E]->(b:P) RETURN b')).toBeUndefined();
  });

  it('⚠️ never lifts null, true or false — they are KEYWORDS, not literal tokens', () => {
    expect(normalizeLiterals('MATCH (n:P {k: null}) RETURN n')).toBeUndefined();
    expect(normalizeLiterals('MATCH (n:P) WHERE n.k IS NULL RETURN n')).toBeUndefined();
    expect(normalizeLiterals('MATCH (n:P) WHERE n.flag = true RETURN n')).toBeUndefined();
    expect(normalizeLiterals('MATCH (n:P) WHERE n.flag = false RETURN n')).toBeUndefined();
  });

  it('declines a text that does not lex, leaving the real error to the parser', () => {
    expect(normalizeLiterals("MATCH (n:P) WHERE n.s = 'unterminated")).toBeUndefined();
  });

  it('⚠️ the LIFTED literal is gone from the text, so a bad span cannot leave it behind', () => {
    // The off-by-one mutant (`tokens[i + 1].pos - 1`) leaves a fragment of the source literal in
    // place, which only shows up as a parse failure and a silent fallback — correct answers at full
    // cost. This is the assertion that makes it loud.
    // ⚠️ THE EXACT TEXT, not just "the literal is absent". `not.toContain('1234')` is too weak:
    // the off-by-one leaves ONE character behind, so `$__ap0 4 RETURN` still passes a
    // does-not-contain check. Pinning the whole string is what makes the mutant loud — and it also
    // pins the trailing space the rewriter emits, which a reader would otherwise have to guess at.
    expect(normalizeLiterals('MATCH (n:P) WHERE n.k = 1234 RETURN n')?.text).toBe(
      'MATCH (n:P) WHERE n.k = $__ap0 RETURN n',
    );
    expect(normalizeLiterals("MATCH (n:P) WHERE n.s = 'zebra' RETURN n")?.text).toBe(
      'MATCH (n:P) WHERE n.s = $__ap0 RETURN n',
    );
    expect(normalizeLiterals('MATCH (n:P) WHERE 7 < n.k RETURN n')?.text).toBe(
      'MATCH (n:P) WHERE $__ap0 < n.k RETURN n',
    );

    const two = normalizeLiterals("MATCH (n:P {k: 99}) WHERE n.s = 'q' RETURN n");

    // The inline position keeps the emitted trailing space before `}` — harmless, and pinned so a
    // change to the rewriter's spacing is a visible decision rather than a surprise.
    expect(two?.text).toBe('MATCH (n:P {k: $__ap0 }) WHERE n.s = $__ap1 RETURN n');
    expect(Object.keys(two?.params ?? {})).toEqual(['__ap0', '__ap1']);
  });
});

describe('the lifted spelling answers exactly as the literal one', () => {
  const g = new Graph();

  for (let i = 0; i < 30; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 7, s: `s${i % 5}`, flag: i % 2 === 0, maybe: i % 3 === 0 ? null : i },
    });
  }

  for (let e = 0; e < 30; e += 1) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(`v${e % 30}`)!,
      to: g.getVertexById(`v${(e * 7 + 1) % 30}`)!,
    });
  }

  // ⚠️ Each pair is the SAME question written with a literal and with an explicit parameter. If the
  // rewrite changed meaning, the lifted form would diverge from the hand-written param form — which
  // is the only reference that cannot itself be rewritten.
  for (const [name, lit, par, params] of [
    [
      'clause =',
      'MATCH (n:P) WHERE n.k = 3 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k = $v RETURN count(*) AS c',
      { v: 3 },
    ],
    [
      'clause >',
      'MATCH (n:P) WHERE n.k > 3 RETURN count(*) AS c',
      'MATCH (n:P) WHERE n.k > $v RETURN count(*) AS c',
      { v: 3 },
    ],
    [
      'string',
      "MATCH (n:P) WHERE n.s = 's2' RETURN count(*) AS c",
      'MATCH (n:P) WHERE n.s = $v RETURN count(*) AS c',
      { v: 's2' },
    ],
    [
      'inline',
      'MATCH (n:P {k: 3}) RETURN count(*) AS c',
      'MATCH (n:P {k: $v}) RETURN count(*) AS c',
      { v: 3 },
    ],
    [
      'two literals',
      "MATCH (n:P) WHERE n.k = 3 AND n.s = 's2' RETURN count(*) AS c",
      'MATCH (n:P) WHERE n.k = $a AND n.s = $b RETURN count(*) AS c',
      { a: 3, b: 's2' },
    ],
    [
      'hop',
      'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 3 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->(b:P) WHERE a.k = $v RETURN count(*) AS c',
      { v: 3 },
    ],
    [
      'quantifier + literal',
      'MATCH (a:P)-[:E]->{1,2}(b:P) WHERE a.k = 3 RETURN count(*) AS c',
      'MATCH (a:P)-[:E]->{1,2}(b:P) WHERE a.k = $v RETURN count(*) AS c',
      { v: 3 },
    ],
    [
      'order + limit + literal',
      'MATCH (n:P) WHERE n.k > 1 RETURN n.k AS v ORDER BY v LIMIT 5',
      'MATCH (n:P) WHERE n.k > $v RETURN n.k AS v ORDER BY v LIMIT 5',
      { v: 1 },
    ],
  ] as const) {
    it(`agrees for ${name}`, () => {
      expect(JSON.stringify(query(g, lit)), name).toBe(JSON.stringify(query(g, par, params)));
    });
  }

  it('⚠️ a USER param named like a synthetic one is not shadowed', () => {
    // The synthetic namespace is `__ap<n>`, so this cannot collide today. The test exists so that a
    // future namespace change fails here rather than silently taking the wrong value.
    const rows = query(g, 'MATCH (n:P) WHERE n.k = $__ap0 RETURN count(*) AS c', { __ap0: 3 });
    const want = query(g, 'MATCH (n:P) WHERE n.k = 3 RETURN count(*) AS c');

    expect(JSON.stringify(rows)).toBe(JSON.stringify(want));
  });

  it('the same shape with different literals answers differently (the cache is not over-sharing)', () => {
    // The failure this guards is the whole mechanism going wrong: if the rewritten text cached a
    // plan but the VALUES did not follow, every call would answer with the first call's constant.
    // ⚠️ It asserts the VALUE followed the plan, not that seven answers differ. The first version
    // projected `n.id`, which reads back as null (item 1500 learned this and I repeated it), so the
    // seven answers collapsed to two distinct row COUNTS and the test failed for the wrong reason.
    for (let k = 0; k < 7; k += 1) {
      const rows = query<{ kk: unknown }>(g, `MATCH (n:P) WHERE n.k = ${k} RETURN n.k AS kk`);

      expect(rows.length, `k=${k}`).toBeGreaterThan(0);
      expect([...new Set(rows.map((r) => r.kk))], `k=${k}`).toEqual([k]);
    }
  });
});
