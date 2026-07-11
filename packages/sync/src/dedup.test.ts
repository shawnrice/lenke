import { describe, expect, test } from 'bun:test';

import { createDedupRegistry } from './dedup.js';

describe('DedupRegistry (exactly-once write ids)', () => {
  test('a marked id is seen; an unmarked one is not', () => {
    const d = createDedupRegistry();
    expect(d.seen('a')).toBe(false);
    d.mark('a');
    expect(d.seen('a')).toBe(true);
    expect(d.seen('b')).toBe(false);
  });

  test('mark is idempotent', () => {
    const d = createDedupRegistry();
    d.mark('a');
    d.mark('a');
    expect(d.seen('a')).toBe(true);
  });

  test('bounded: the oldest ids evict past capacity', () => {
    const d = createDedupRegistry({ capacity: 2 });
    d.mark('a');
    d.mark('b');
    d.mark('c'); // evicts 'a'
    expect(d.seen('a')).toBe(false);
    expect(d.seen('b')).toBe(true);
    expect(d.seen('c')).toBe(true);
  });
});
