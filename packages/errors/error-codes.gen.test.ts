import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { renderRustModule, RUST_TARGET } from './gen-rust.ts';
import { ErrorCode } from './src/index.ts';

describe('error-code Rust mirror', () => {
  test('committed error_codes.rs is not stale (run `bun run gen:rust` to refresh)', () => {
    const onDisk = readFileSync(RUST_TARGET, 'utf8');
    expect(onDisk).toBe(renderRustModule());
  });

  test('every TS code appears as an as_str() arm in the Rust mirror', () => {
    const rust = renderRustModule();

    for (const value of Object.values(ErrorCode)) {
      expect(rust).toContain(`=> "${value}"`);
    }
  });
});
