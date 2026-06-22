import { describe, expect, test } from 'bun:test';

import { keyBy } from './keyBy.js';

describe('keyBy', () => {
  test('indexes items by a derived key', () => {
    const byId = keyBy((u: { id: number }) => u.id, [{ id: 1 }, { id: 2 }]);

    expect(byId.get(1)).toEqual({ id: 1 });
    expect(byId.get(2)).toEqual({ id: 2 });
  });

  test('last write wins on a duplicate key', () => {
    const byId = keyBy(
      (u: { id: number; v: string }) => u.id,
      [
        { id: 1, v: 'first' },
        { id: 1, v: 'second' },
      ],
    );

    expect(byId.get(1)?.v).toBe('second');
  });

  test('curried form', () => {
    const byLength = keyBy((s: string) => s.length);

    expect(byLength(['a', 'bb']).get(2)).toBe('bb');
  });
});
