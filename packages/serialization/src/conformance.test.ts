import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { Graph } from '@lenke/core';
import type { ErrorCode } from '@lenke/errors';
import { hasErrorCode } from '@lenke/errors';

import { deserialize, serialize } from './index.js';
import type { FormatName } from './index.js';

/**
 * The TS half of the cross-implementation codec conformance corpus. It reads the
 * SAME shared fixture (`/conformance/codec-corpus.json`) as the Rust half
 * (`crates/lenke-engine/tests/codec_conformance.rs`) and applies the SAME structural
 * normalization, so the two engines' accepted-input / round-trip behaviour cannot drift
 * apart silently.
 *
 * That claim was FALSE between the retirement of `pl-graph-core` and item 2536: the Rust
 * reader lived in that crate and was lost with it, so this file was the only reader and
 * the `canonical_normal` comparison below was TS against a committed string — evidence
 * that Rust once agreed, not that it still does. Items 2533-2535 then found three JSON
 * acceptance divergences on exactly this surface. If either half moves, grep for
 * `codec-corpus` and fix BOTH; one reader is not a cross-implementation test.
 * Edge ids are excluded from the comparison (pg-text drops them; Rust uses
 * `e{index}` while TS uses a random id for an id-less edge) and labels/props are
 * order-normalized.
 */

type RejectCase = { format: string; input: string; code: string };
type Corpus = { canonical: string; canonical_normal: string; reject: RejectCase[] };

const corpus: Corpus = JSON.parse(
  readFileSync(`${import.meta.dir}/../../../conformance/codec-corpus.json`, 'utf8'),
) as Corpus;

const propRepr = (bag: Record<string, unknown>): string =>
  Object.keys(bag)
    .sort()
    .map((k) => `${k}=${JSON.stringify(bag[k])}`)
    .join(',');

/** Order-independent string form of a graph; edge ids deliberately ignored. */
const normalize = (g: Graph): string => {
  const lines: string[] = [];

  for (const v of g.vertices) {
    const labels = [...v.labels].sort().join(',');
    lines.push(`V ${v.id} [${labels}] {${propRepr(v.properties)}}`);
  }

  for (const e of g.edges) {
    const type = [...e.labels].sort().join(',');
    lines.push(`E ${e.from.id}->${e.to.id} :${type} {${propRepr(e.properties)}}`);
  }

  return lines.sort().join('\n');
};

describe('codec conformance (shared cross-impl corpus)', () => {
  /*
   * The reciprocal of the Rust half's own guard (item 2537). `include_str!` over there catches the
   * corpus MOVING; neither side caught what actually happened at 2536 — the corpus stayed put and
   * the Rust reader was deleted with its crate, leaving this file's docstring claiming a
   * cross-implementation check that no longer existed.
   *
   * So each half now asserts the other still reads the fixture. A shared corpus is cross-engine
   * only while both sides read it, and a comment cannot be the thing that establishes that.
   */
  test('the Rust half of this corpus still exists and still reads it', () => {
    const rustHalf = readFileSync(
      `${import.meta.dir}/../../../crates/lenke-engine/tests/codec_conformance.rs`,
      'utf8',
    );

    expect(rustHalf).toContain('codec-corpus.json');
    // And still APPLIES it, rather than merely mentioning it in prose.
    expect(rustHalf).toContain('canonical_normal');
    expect(rustHalf).toContain('reject');
  });

  test('the canonical graph round-trips through every format, structurally', () => {
    const g = deserialize(corpus.canonical, 'ndjson', new Graph());
    const want = normalize(g);
    // Cross-impl golden: must match the exact string the Rust engine produces,
    // proving both interpret the canonical graph identically.
    expect(want).toBe(corpus.canonical_normal);

    for (const format of ['pg-json', 'pg-text', 'graphson', 'csv', 'ndjson'] as FormatName[]) {
      const blob = serialize(g, format);
      const back = deserialize(blob, format, new Graph());
      expect(normalize(back)).toBe(want);
    }
  });

  test('malformed inputs are rejected with the expected ErrorCode', () => {
    for (const { format, input, code } of corpus.reject) {
      let caught: unknown;

      try {
        // `format` is a plain string from the JSON corpus; the runtime guard in
        // `codecFor` still rejects an unknown one.
        deserialize(input, format as FormatName, new Graph());
      } catch (e) {
        caught = e;
      }

      expect(caught, `${format} accepted malformed input: ${input}`).toBeDefined();
      expect(
        hasErrorCode(caught, code as ErrorCode),
        `wrong error code for ${format} on ${input}`,
      ).toBe(true);
    }
  });
});
