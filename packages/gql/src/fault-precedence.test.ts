import { describe, expect, it } from 'bun:test';

/**
 * WHICH static fault wins when a query has more than one — pinned, because the two engines
 * disagree and nothing was watching it.
 *
 * `compile` raises two faults eagerly, in a fixed order: `checkLinearScope` runs over EVERY clause
 * of every part first (an unbound variable), and the unknown-function check runs after
 * `compileLinear` completes. So TS always reports the SCOPE fault when a query has both, whatever
 * order they are written in.
 *
 * NATIVE DOES NOT. It raises both from the parser, so it reports whichever comes FIRST IN THE TEXT.
 * Measured side by side at item 916 on the same four queries:
 *
 *     query                                              TS                    native
 *     RETURN missingVar.k                                scope                 scope
 *     RETURN nosuchfn(n.k)                               E_UNKNOWN_FUNCTION    E_UNKNOWN_FUNCTION
 *     RETURN nosuchfn(n.k) AS a, missingVar.k AS b       scope                 E_UNKNOWN_FUNCTION
 *     RETURN missingVar.k AS b, nosuchfn(n.k) AS a       scope                 scope
 *
 * So the engines agree on a query with ONE fault and disagree on one with two, in one of the two
 * written orders — and native is written-order sensitive where TS is not. Recorded as an open
 * divergence; neither is obviously wrong (a standard rarely fixes which static error is reported
 * first), but this engine's invariant is that observable behaviour matches, and which error code a
 * caller receives is observable.
 *
 * WHY IT IS PINNED HERE RATHER THAN FIXED: item 908 proposed fusing `checkLinearScope` into
 * `compileLinear` for ~15-19% of planning, and noted the fusion changes WHEN the scope fault is
 * raised relative to other compile-time work. These tests make that change detectable — fusing
 * would move TS towards native's written-order behaviour, which is a decision to take deliberately
 * rather than discover.
 */
import { Graph } from '@lenke/core';

import { query } from './index.ts';

const g = new Graph();

g.addVertex({ id: 'a', labels: ['L'], properties: { k: 1 } });

/** The error code `query` raises for `src`, or `'NONE'`. */
const faultOf = (src: string): string => {
  try {
    // Consumed, not discarded: `query` is lazy, so an un-iterated generator raises nothing.
    const rows = [...query(g, src)].length;

    return rows >= 0 ? 'NONE' : 'NONE';
  } catch (e) {
    return String((e as { code?: string }).code ?? 'NO_CODE');
  }
};

describe('static fault precedence', () => {
  it('an unbound variable alone is a scope fault', () => {
    expect(faultOf('MATCH (n:L) RETURN missingVar.k AS x')).toBe('E_SYNTAX');
  });

  it('an unknown function alone is E_UNKNOWN_FUNCTION', () => {
    expect(faultOf('MATCH (n:L) RETURN nosuchfn(n.k) AS x')).toBe('E_UNKNOWN_FUNCTION');
  });

  // THE PAIR THAT DISAGREES WITH NATIVE. TS reports the scope fault in BOTH written orders because
  // `checkLinearScope` runs over everything before `compileLinear`; native reports whichever is
  // written first. The second case below is where they agree only by coincidence of ordering.
  it('with BOTH faults, the unknown function written first, TS reports SCOPE', () => {
    expect(faultOf('MATCH (n:L) RETURN nosuchfn(n.k) AS a, missingVar.k AS b')).toBe('E_SYNTAX');
  });

  it('with BOTH faults, the unbound variable written first, TS reports SCOPE', () => {
    expect(faultOf('MATCH (n:L) RETURN missingVar.k AS b, nosuchfn(n.k) AS a')).toBe('E_SYNTAX');
  });

  // TS's order-INDEPENDENCE is the property a fusion would break, so it gets its own assertion
  // rather than being implied by the two cases above.
  it('TS is written-order INDEPENDENT for which fault wins', () => {
    const a = faultOf('MATCH (n:L) RETURN nosuchfn(n.k) AS a, missingVar.k AS b');
    const b = faultOf('MATCH (n:L) RETURN missingVar.k AS b, nosuchfn(n.k) AS a');

    expect(a).toBe(b);
  });

  // A scope fault in a LATER clause still wins over an unknown function in an earlier one, which is
  // the specific consequence of `checkLinearScope` walking every clause before anything compiles.
  it('a scope fault in a later clause beats an unknown function in an earlier one', () => {
    expect(faultOf('MATCH (n:L) LET y = nosuchfn(n.k) RETURN missingVar.k AS x')).toBe('E_SYNTAX');
  });
});
