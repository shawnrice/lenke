import { describe, expect, test } from 'bun:test';

import { chainLabelsPresent } from './hop-chain-values.js';

/*
 * Item 2507: THE ONLY GATE THAT CAN CATCH A MUTATION OF THIS CHECK.
 *
 * `chainLabelsPresent` guards the chain-CSR build: a chain naming an edge label the graph does not
 * have returns zero rows, and item 2506 measured 25.91 MiB / 7.9 ms to discover that by building the
 * CSRs anyway — 1.8x the cost of the same chain doing real work, where the GQL surface answers in
 * 0.35 MiB.
 *
 * **The check is ANSWER-EQUIVALENT by construction.** Zero rows either way, so no differential test,
 * no cross-engine fuzzer and no conformance probe can observe it — invert the predicate, drop a hop
 * from the `every`, flip the `> 0` to `>= 0`, and the entire suite stays green while the saving
 * silently disappears or, worse, a productive chain starts returning nothing. That is exactly the
 * failure `perf-gate-needs-its-own-test` exists for, and it is why the predicate was extracted from
 * the walks rather than inlined: a pure function can be mutated and CAUGHT.
 *
 * So the rows below are deliberately exhaustive about the directions a mutation can go:
 *
 *   - present labels must return TRUE  (a mutation here breaks the ANSWER: a real chain returns [])
 *   - absent labels must return FALSE  (a mutation here only loses the saving, silently)
 *   - an EMPTY SET must count as absent (same answer, same saving — and the `.size` read is the
 *     difference between `has` and this)
 *   - MIXED hops must return FALSE on the strength of ONE bad hop (`every`, not `some`)
 *   - the hop's DIRECTION flag must be ignored (it is `[label, forward]`, and only `[0]` matters)
 */
const sized = (n: number) => ({ size: n });

describe('chainLabelsPresent', () => {
  const index = new Map([
    ['E', sized(200_000)],
    ['F', sized(1)],
    ['EMPTY', sized(0)],
  ]);

  test('every hop names a label with edges — build', () => {
    expect(chainLabelsPresent(index, [['E', true]])).toBe(true);
    expect(
      chainLabelsPresent(index, [
        ['E', true],
        ['E', true],
      ]),
    ).toBe(true);
    expect(
      chainLabelsPresent(index, [
        ['E', true],
        ['F', false],
        ['E', true],
      ]),
    ).toBe(true);
  });

  test('a SINGLE edge is enough — the check is existence, not volume', () => {
    expect(
      chainLabelsPresent(index, [
        ['F', true],
        ['F', true],
      ]),
    ).toBe(true);
  });

  test('an ABSENT label refuses', () => {
    expect(chainLabelsPresent(index, [['NOSUCH', true]])).toBe(false);
    expect(
      chainLabelsPresent(index, [
        ['NOSUCH', true],
        ['NOSUCH', true],
      ]),
    ).toBe(false);
  });

  test('a label present with an EMPTY SET counts as absent', () => {
    // `index.has('EMPTY')` is true, so a `has`-based check would wrongly build here. Same answer,
    // same saving — this row is what pins `.size` rather than `has`.
    expect(chainLabelsPresent(index, [['EMPTY', true]])).toBe(false);
    expect(
      chainLabelsPresent(index, [
        ['E', true],
        ['EMPTY', false],
      ]),
    ).toBe(false);
  });

  test('ONE bad hop refuses the whole chain, wherever it sits', () => {
    expect(
      chainLabelsPresent(index, [
        ['NOSUCH', true],
        ['E', true],
      ]),
    ).toBe(false);
    expect(
      chainLabelsPresent(index, [
        ['E', true],
        ['NOSUCH', true],
      ]),
    ).toBe(false);
    expect(
      chainLabelsPresent(index, [
        ['E', true],
        ['NOSUCH', true],
        ['E', true],
      ]),
    ).toBe(false);
  });

  test('the DIRECTION flag is irrelevant', () => {
    expect(
      chainLabelsPresent(index, [
        ['E', false],
        ['E', true],
      ]),
    ).toBe(true);
    expect(chainLabelsPresent(index, [['NOSUCH', false]])).toBe(false);
  });

  test('an EMPTY hop list builds — vacuously true, and not this check’s business', () => {
    // A zero-hop chain never reaches the CSR build; refusing here would be a different decision
    // taken in the wrong place.
    expect(chainLabelsPresent(index, [])).toBe(true);
  });

  test('an EMPTY index refuses everything except the empty chain', () => {
    const bare = new Map<string, { readonly size: number }>();

    expect(chainLabelsPresent(bare, [['E', true]])).toBe(false);
    expect(chainLabelsPresent(bare, [])).toBe(true);
  });
});
