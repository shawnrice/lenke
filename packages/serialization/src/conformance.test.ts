import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { Graph } from '@pl-graph/core';
import type { ErrorCode } from '@pl-graph/errors';
import { hasErrorCode } from '@pl-graph/errors';

import { deserialize, serialize } from './index.js';
import type { FormatName } from './index.js';

/**
 * The TS half of the cross-implementation codec conformance corpus. It reads the
 * SAME shared fixture (`/conformance/codec-corpus.json`) as the Rust crate's
 * conformance test and applies the SAME structural normalization, so the two
 * engines' accepted-input / round-trip behaviour cannot drift apart silently.
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
        deserialize(input, format, new Graph());
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
