import { describe, expect, it } from 'bun:test';

/**
 * `recordGet`'s three-valued contract: present, ABSENT, and present-with-`undefined`.
 *
 * These arrived with item 898, which tried reading a record field in ONE hash probe instead of two
 * and was REFUTED on measurement (0.96x/1.00x on the arms that call it per row; see CLOSED.md). The
 * tests outlived the change because the contract they pin is not about the implementation — both
 * the one-probe and two-probe forms satisfy it, which is exactly why the revert was safe:
 *
 *   present, not undefined  -> the value
 *   ABSENT                  -> null
 *   present as `undefined`  -> undefined, NOT null
 *
 * That last row is the one nothing tested. `LenkeRecord` stores values as-is and leaves
 * normalization to its callers, so a stored `undefined` is not assumed impossible — and any future
 * attempt to collapse the probes has to keep it distinguishable from absent. Verified by mutation:
 * coalescing at the `get`, or dropping the `has` fallback, fails this file and nothing else.
 */
import { LenkeRecord } from '@lenke/core';

import { recordGet } from './executor/scalars.ts';

describe('recordGet probing', () => {
  it('reads a present value', () => {
    const r = LenkeRecord.from([
      ['a', 1],
      ['b', 'two'],
    ]);

    expect(recordGet(r, 'a')).toBe(1);
    expect(recordGet(r, 'b')).toBe('two');
  });

  it('reads a present NULL as null, not as absent', () => {
    // null is a first-class stored value in this engine, so this must come back null either way —
    // it is the case that would be indistinguishable if `get`'s result were trusted blindly for
    // nullish rather than for `undefined` specifically.
    const r = LenkeRecord.from([['a', null]]);

    expect(recordGet(r, 'a')).toBeNull();
    expect(r.has('a')).toBe(true);
  });

  it('returns null for an ABSENT key', () => {
    const r = LenkeRecord.from([['a', 1]]);

    expect(recordGet(r, 'nope')).toBeNull();
  });

  it('returns undefined for a key stored WITH the value undefined', () => {
    // The disambiguating case. `get` gives `undefined` here exactly as it does for an absent key,
    // so only the `has` fallback can tell them apart — and the two must NOT return the same thing.
    const r = LenkeRecord.from([['a', undefined]]);

    expect(r.has('a')).toBe(true);
    expect(recordGet(r, 'a')).toBeUndefined();
    // ...while a genuinely absent key on the same record is null.
    expect(recordGet(r, 'b')).toBeNull();
    // Stated as the inequality that matters: absent and stored-undefined differ.
    expect(recordGet(r, 'a')).not.toBe(recordGet(r, 'b'));
  });

  it('reads falsy values without treating them as absent', () => {
    const r = LenkeRecord.from([
      ['zero', 0],
      ['empty', ''],
      ['no', false],
      ['nan', Number.NaN],
    ]);

    expect(recordGet(r, 'zero')).toBe(0);
    expect(recordGet(r, 'empty')).toBe('');
    expect(recordGet(r, 'no')).toBe(false);
    expect(recordGet(r, 'nan')).toBeNaN();
  });
});
