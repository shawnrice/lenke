import { describe, expect, test } from 'bun:test';

import {
  CONFIG_IDS,
  DEFAULT_CONFIG,
  NATIVE_ONLY_CONFIG_IDS,
  PARALLELISM_CONFIG_ID,
} from './core/Graph.js';

/*
 * Item 2527: the config wire ids are a CROSS-ENGINE contract, and "take the next id" was unsafe
 * advice.
 *
 * The FFI limit setter is ONE export keyed by id, so an id this engine assigns must not be one the
 * native engine has already taken — a collision does not error, it silently drives a different
 * native knob.
 *
 * `CONFIG_IDS`'s note says the list is append-only, and the previous `PARALLELISM_CONFIG_ID` comment
 * mentioned only that "id 4 is reserved". A reader seeing 0-3 and 5 would take **6** — which native
 * has assigned to `ConfigId::LimitsIntermediateCells`. Verified against
 * `crates/lenke-engine/src/store.rs`: native uses 0, 1, 2, 3, 4, 5, 6, so the next free id is 7.
 *
 * ## WHAT THESE TESTS CAN AND CANNOT CATCH
 *
 * They pin the TS side: no TS id may sit in the native-only reserved set, and the next free id is
 * what the comment claims. They CANNOT see a change made on the Rust side — `store.rs` is not
 * reachable from a TS test — so a future native id must still be mirrored into
 * `NATIVE_ONLY_CONFIG_IDS` by hand. Naming that limit is the point of saying it here rather than
 * implying the pair is automatically in sync.
 *
 * The default VALUES are pinned for the same reason: `DEFAULT_CONFIG` says it "Mirrors the Rust
 * `GraphConfig::default()` … part of the cross-engine contract, not a per-engine tuning choice".
 * Compared entry by entry against `impl Default for GraphLimits`, all four shared limits matched.
 */
describe('config wire ids do not collide with native-only ids (item 2527)', () => {
  const tsIds = [...Object.values(CONFIG_IDS), PARALLELISM_CONFIG_ID];

  test('no TS wire id is one native has reserved for itself', () => {
    for (const id of tsIds) {
      expect(NATIVE_ONLY_CONFIG_IDS).not.toContain(id);
    }
  });

  test('TS ids are distinct', () => {
    expect(new Set(tsIds).size).toBe(tsIds.length);
  });

  /*
   * The number a future reader will act on. Native uses 0-6 (verified in `store.rs`), so anything
   * below 7 is taken by one engine or the other.
   */
  test('the next free id is 7, counting both engines', () => {
    const taken = new Set([...tsIds, ...NATIVE_ONLY_CONFIG_IDS]);
    let next = 0;

    while (taken.has(next)) {
      next += 1;
    }

    expect(next).toBe(7);
  });

  test('the ids themselves are the documented ones', () => {
    expect(CONFIG_IDS['limits.range']).toBe(0);
    expect(CONFIG_IDS['limits.trail']).toBe(1);
    expect(CONFIG_IDS['limits.intermediate']).toBe(2);
    expect(CONFIG_IDS['limits.operatorChain']).toBe(3);
    expect(PARALLELISM_CONFIG_ID).toBe(5);
  });

  /* The default limits, which the source calls part of the cross-engine contract. */
  test('DEFAULT_CONFIG matches the Rust GraphConfig::default() values', () => {
    expect(DEFAULT_CONFIG.limits.range).toBe(1_000_000);
    expect(DEFAULT_CONFIG.limits.trail).toBe(1_000_000);
    expect(DEFAULT_CONFIG.limits.intermediate).toBe(50_000_000);
    expect(DEFAULT_CONFIG.limits.operatorChain).toBe(1_024);
    expect(DEFAULT_CONFIG.parallelism).toBe(1);
  });
});
