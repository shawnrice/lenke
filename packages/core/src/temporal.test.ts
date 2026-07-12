import { describe, expect, test } from 'bun:test';

import {
  civilFromDays,
  daysFromCivil,
  Duration,
  formatDuration,
  LocalDate,
  parseDate,
  parseDateTime,
  parseDuration,
  temporalCmpTotal,
  temporalRelCmp,
} from './temporal.js';

// These mirror the Rust `temporal::tests` one-for-one — identical inputs and
// expected outputs pin the two engines' calendar math + ISO parse/format to the
// same byte string (the real cross-engine differential rides on top of this).

describe('temporal: civil calendar', () => {
  test('round-trips known dates', () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2000, 1, 1],
      [2020, 2, 29],
      [1969, 12, 31],
      [1600, 12, 31],
      [2262, 4, 11],
    ] as const) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual([y, m, d]);
    }

    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(1970, 1, 2)).toBe(1);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
  });
});

describe('temporal: parse/format round-trips', () => {
  test('date', () => {
    for (const s of ['1970-01-01', '2020-02-29', '1999-12-31', '2026-07-11']) {
      expect(parseDate(s).toJSON()['@date']).toBe(s);
    }

    expect(() => parseDate('2020-13-01')).toThrow();
    expect(() => parseDate('not-a-date')).toThrow();
  });

  test('datetime (incl. fraction + space separator + pre-epoch)', () => {
    for (const s of [
      '2020-01-01T00:00:00',
      '2026-07-11T13:45:06',
      '2020-01-01T10:15:30.5',
      '1969-12-31T23:59:59',
    ]) {
      expect(parseDateTime(s).toJSON()['@datetime']).toBe(s);
    }

    expect(parseDateTime('2020-01-01 10:15:30').toJSON()['@datetime']).toBe('2020-01-01T10:15:30');
  });

  test('duration normalizes years->months, weeks->days', () => {
    expect(formatDuration(parseDuration('P1Y2M3W4DT5H6M7S'))).toBe('P14M25DT18367S');
    expect(formatDuration(parseDuration('P1Y'))).toBe('P12M');
    expect(formatDuration(parseDuration('PT0S'))).toBe('PT0S');
    expect(formatDuration(parseDuration('P0D'))).toBe('PT0S');
    expect(formatDuration(parseDuration('PT1.5S'))).toBe('PT1.5S');
    // canonical output re-parses to itself
    const canon = parseDuration('P14M25DT18367S');
    expect(formatDuration(parseDuration(formatDuration(canon)))).toBe(formatDuration(canon));
    expect(() => parseDuration('1Y')).toThrow();
  });
});

describe('temporal: ordering', () => {
  test('is deterministic and matches the Rust policy', () => {
    const d1 = parseDate('2020-01-01');
    const d2 = parseDate('2020-06-01');
    expect(temporalRelCmp(d1, d2)).toBe(-1);
    expect(temporalCmpTotal(d1, d2)).toBe(-1);

    const t1 = parseDateTime('2020-01-01T00:00:00');
    expect(temporalRelCmp(d1, t1)).toBeNull(); // cross-kind: UNKNOWN
    expect(temporalCmpTotal(d1, t1)).toBe(-1); // date kind-rank < datetime

    const du = parseDuration('P1M');
    expect(temporalRelCmp(du, du)).toBeNull(); // durations not relationally ordered
    expect(temporalCmpTotal(du, du)).toBe(0);
    expect(temporalCmpTotal(t1, du)).toBe(-1); // datetime kind-rank < duration
  });

  test('instances expose Rust-identical fields', () => {
    expect(parseDate('1970-01-02')).toEqual(new LocalDate(1));
    expect(parseDateTime('1970-01-01T00:00:01').secs).toBe(1);
    expect(parseDuration('P2M3DT4S')).toEqual(new Duration(2, 3, 4, 0));
  });
});
