import { describe, expect, test } from 'bun:test';

import {
  civilFromDays,
  daysFromCivil,
  parseDate,
  parseDuration,
  temporalArith,
} from './temporal.js';

/*
 * Item 2529: the civil-calendar rules were REACHED but never VERIFIED. One differential against an
 * independent oracle closes the whole class.
 *
 * `temporal.ts` is 1336 lines of calendar math; `temporal.test.ts` is 274 lines comparing against
 * hand-typed literals ("round-trips known dates") with no independent oracle. Mutation measured what
 * that costs. All four below are WRONG ANSWERS, not equivalent shapes, and `daysInMonth` IS reached
 * (making it throw fails 3 core tests):
 *
 *     MUTANT                                   core   gql   native
 *     February never has 29 days                0      1     1     <- caught, but DOWNSTREAM only
 *     drop the /400 rule (1600, 2000 not leap)  0      0     0     <- SURVIVED EVERYTHING
 *     drop the /100 rule (1900, 2100 leap)      0      0     0     <- SURVIVED EVERYTHING
 *     November has 31 days                      0      0     0     <- SURVIVED EVERYTHING
 *
 * Three wrong calendar answers survived ~10,800 tests across every package. The century exception had
 * no discriminating fixture anywhere: `temporal.test.ts` uses 1600 and 2000, both leap by the /400
 * rule, and never 1900 or 2100 — the years that decide the `% 100` clause.
 *
 * ## WHY A DIFFERENTIAL, AND WHY `Date` IS A LEGITIMATE ORACLE
 *
 * Item 2528 found ONE brute-force differential catching three B+-tree corruptions it was not written
 * for, while hand-enumerated expectations caught none of these. So rather than type four more
 * literals, this compares against JS `Date` — a SEPARATE implementation in the runtime, proleptic
 * Gregorian over this range, which is the calendar `temporal.ts` documents.
 *
 * Years stay at 1600+ so `Date.UTC`'s two-digit-year remapping (0-99 -> 1900-1999) is never in play.
 */
const EPOCH_MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 per the runtime, independent of anything in `temporal.ts`. */
const daysOracle = (y: number, m: number, d: number): number =>
  Date.UTC(y, m - 1, d) / EPOCH_MS_PER_DAY;

/** Last day of month `m`: day 0 of month `m` (0-based) is the final day of month `m - 1`. */
const lastDayOracle = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

const iso = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/*
 * THE DISCRIMINATING YEARS, chosen so every clause of the leap rule is decided by at least one:
 *   1900, 2100, 2200 — divisible by 100, NOT 400 -> NOT leap   (the clause nothing exercised)
 *   1600, 2000, 2400 — divisible by 400          -> leap
 *   2020, 2024       — divisible by 4 only       -> leap
 *   2021, 2023       — not divisible by 4        -> not leap
 */
const YEARS = [1600, 1700, 1800, 1900, 1996, 2000, 2020, 2021, 2023, 2024, 2100, 2200, 2400];

describe('civil calendar matches an independent oracle (item 2529)', () => {
  test('daysFromCivil agrees with Date.UTC on every month boundary', () => {
    for (const y of YEARS) {
      for (let m = 1; m <= 12; m += 1) {
        for (const d of [1, lastDayOracle(y, m)]) {
          expect(daysFromCivil(y, m, d)).toBe(daysOracle(y, m, d));
        }
      }
    }
  });

  test('civilFromDays is the exact inverse across those boundaries', () => {
    for (const y of YEARS) {
      for (let m = 1; m <= 12; m += 1) {
        const d = lastDayOracle(y, m);
        const [ry, rm, rd] = civilFromDays(daysFromCivil(y, m, d));

        expect([ry, rm, rd]).toEqual([y, m, d]);
      }
    }
  });

  /*
   * `daysInMonth` is internal, so it is tested through `parseDate` — and the contract is ROLL-OVER,
   * not rejection. `date('2025-02-29')` yields `2025-03-01` deliberately (the MCP guide documents it:
   * "a valid-looking overflow like date('2025-02-29') rolls to 2025-03-01"; only an out-of-range
   * FIELD like month 13 is an error). My first version of this file asserted rejection and failed on
   * live code — the differential caught my wrong assumption before I could believe it.
   *
   * `Date.UTC` rolls over the SAME way, which is what makes it a usable oracle here: measured,
   * lenke and the runtime agree on 2021-02-29, 2023-04-31, 1900-02-29, 2020-02-29 and 2023-11-31.
   * A wrong month length rolls to a DIFFERENT date, so this discriminates every mutant above.
   */
  const rolled = (y: number, m: number, d: number): string =>
    new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

  test('an over-long day rolls to exactly where the oracle rolls it', () => {
    for (const y of YEARS) {
      for (let m = 1; m <= 12; m += 1) {
        const last = lastDayOracle(y, m);

        // The last real day is kept verbatim...
        expect(String(parseDate(iso(y, m, last)))).toBe(iso(y, m, last));

        /*
         * ...and the day after it rolls into the next month — but ONLY while that day is still a
         * legal FIELD. Day 32 is out of range for any month and THROWS `E_INVALID_VALUE`, the same
         * class as month 13; roll-over applies to a valid-looking day that the specific month does
         * not have (29 in a non-leap February, 31 in April). My first sweep asserted `last + 1`
         * unconditionally and hit `1600-01-32`, which is my bug, not the calendar's.
         */
        if (last + 1 <= 31) {
          expect(String(parseDate(iso(y, m, last + 1)))).toBe(rolled(y, m, last + 1));
        }
      }
    }
  });

  /* The same facts stated so a FAILURE NAMES THE RULE — a bare loop cannot say which rule broke. */
  test('February follows the full century rule', () => {
    expect(String(parseDate('2020-02-29'))).toBe('2020-02-29'); // /4 only -> leap
    expect(String(parseDate('2000-02-29'))).toBe('2000-02-29'); // /400 -> leap
    expect(String(parseDate('1600-02-29'))).toBe('1600-02-29');
    expect(String(parseDate('2021-02-29'))).toBe('2021-03-01'); // not /4 -> rolls
    expect(String(parseDate('1900-02-29'))).toBe('1900-03-01'); // /100 not /400 — the uncovered case
    expect(String(parseDate('2100-02-29'))).toBe('2100-03-01');
  });

  test('the 30-day months are April, June, September and November', () => {
    for (const m of [4, 6, 9, 11]) {
      expect(String(parseDate(iso(2023, m, 30)))).toBe(iso(2023, m, 30));
      expect(String(parseDate(iso(2023, m, 31)))).toBe(rolled(2023, m, 31));
    }

    for (const m of [1, 3, 5, 7, 8, 10, 12]) {
      expect(String(parseDate(iso(2023, m, 31)))).toBe(iso(2023, m, 31));
    }
  });

  /*
   * MONTH ARITHMETIC — the ONLY place `daysInMonth`/`isLeap` are reachable from.
   *
   * Measured: `daysInMonth` is called from exactly one site, `addCalendar`'s
   * `Math.min(d, daysInMonth(ny, nm))`, and `isLeap` only from `daysInMonth`. So the day-CLAMP when
   * adding months is the whole observable surface of both, which is why the `parseDate` rows above
   * cannot see them — `parseDate` validates fields and then uses the day-number algebra, which rolls
   * over arithmetically without consulting a month length. (I confirmed that the hard way: the rows
   * above left all four calendar mutants alive.)
   *
   * These expectations are HAND-COMPUTED, and necessarily so: JS `Date` is NOT an oracle for month
   * arithmetic, because it ROLLS (Jan 31 + 1 month -> Mar 3) where calendar arithmetic CLAMPS
   * (Jan 31 + 1 month -> Feb 28/29). An independent oracle exists for day numbers; for this
   * convention there is none in the runtime, so the four rules are stated directly.
   *
   * Each line kills one of the mutants that survived ~10,800 tests.
   */
  const plusMonths = (d: string, months: number): string =>
    String(temporalArith('+', parseDate(d), parseDuration(`P${months}M`)));

  test('adding a month CLAMPS the day using the full leap rule', () => {
    // /4 only -> leap: February has 29.
    expect(plusMonths('2020-01-31', 1)).toBe('2020-02-29');
    // /400 -> leap. Kills the mutant that drops the /400 clause.
    expect(plusMonths('2000-01-31', 1)).toBe('2000-02-29');
    expect(plusMonths('1600-01-31', 1)).toBe('1600-02-29');
    // /100 but NOT /400 -> NOT leap. Kills the mutant that drops the /100 clause — the rule no
    // fixture in the repo discriminated.
    expect(plusMonths('1900-01-31', 1)).toBe('1900-02-28');
    expect(plusMonths('2100-01-31', 1)).toBe('2100-02-28');
    // not /4 -> not leap.
    expect(plusMonths('2021-01-31', 1)).toBe('2021-02-28');
  });

  test('adding a month CLAMPS into each 30-day month', () => {
    expect(plusMonths('2023-03-31', 1)).toBe('2023-04-30');
    expect(plusMonths('2023-05-31', 1)).toBe('2023-06-30');
    expect(plusMonths('2023-08-31', 1)).toBe('2023-09-30');
    // November. Kills the mutant that gives it 31 days.
    expect(plusMonths('2023-10-31', 1)).toBe('2023-11-30');
  });

  test('CONTROL: a day that fits is not clamped, and 31-day months keep 31', () => {
    expect(plusMonths('2023-01-15', 1)).toBe('2023-02-15');
    expect(plusMonths('2023-12-31', 1)).toBe('2024-01-31');
    expect(plusMonths('2023-07-31', 1)).toBe('2023-08-31');
  });

  /* The oracle itself, in case a future runtime surprises us. */
  test('CONTROL: the oracle reports the textbook lengths', () => {
    expect(lastDayOracle(2020, 2)).toBe(29);
    expect(lastDayOracle(1900, 2)).toBe(28);
    expect(lastDayOracle(2000, 2)).toBe(29);
    expect(lastDayOracle(2023, 11)).toBe(30);
    expect(lastDayOracle(2023, 12)).toBe(31);
    expect(daysOracle(1970, 1, 1)).toBe(0);
  });
});
