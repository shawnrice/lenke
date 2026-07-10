import { describe, expect, test } from 'bun:test';

import { detectFormat, FORMATS, formatFor, isFormat } from './io.js';

describe('format detection', () => {
  test('maps known extensions (case-insensitively)', () => {
    expect(detectFormat('g.ndjson')).toBe('ndjson');
    expect(detectFormat('g.jsonl')).toBe('ndjson');
    expect(detectFormat('g.csv')).toBe('csv');
    expect(detectFormat('g.graphson')).toBe('graphson');
    expect(detectFormat('/path/to/G.NDJSON')).toBe('ndjson');
  });

  test('leaves ambiguous / unknown extensions undetected', () => {
    expect(detectFormat('g.json')).toBeUndefined(); // pg-json vs graphson
    expect(detectFormat('graph')).toBeUndefined();
  });

  test('formatFor honors an explicit override and validates it', () => {
    expect(formatFor('g.json', 'pg-json')).toBe('pg-json');
    expect(() => formatFor('g.json')).toThrow(/infer a format/);
    expect(() => formatFor('g.ndjson', 'bogus')).toThrow(/Unknown format/);
  });

  test('isFormat / FORMATS', () => {
    expect(isFormat('csv')).toBe(true);
    expect(isFormat('xml')).toBe(false);
    expect(FORMATS).toContain('graphson');
  });
});
