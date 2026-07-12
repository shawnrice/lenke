/**
 * ISO/IEC 39075 temporal values — `DATE`, `LOCAL DATETIME`, `DURATION`.
 *
 * A byte-for-byte port of the Rust core's `temporal` module: the calendar math
 * is Howard Hinnant's civil-from-days algorithm and the ISO-8601 parse/format is
 * hand-rolled, so both engines produce the identical wire string. **Byte-identity
 * is defined by the ISO-8601 string (`format`) and the comparison order**, not by
 * the field layout. JS has no native calendar-date / calendar-duration, so each
 * type is a small branded class (discriminated by `instanceof` + a `kind` tag),
 * with a `toJSON()` that emits the tagged form the JSON codecs round-trip.
 *
 * Scope (phase 0): the zone-less trio. `ZONED DATETIME` / `LOCAL|ZONED TIME`
 * come later.
 */

const SECS_PER_DAY = 86_400;

/** Rust integer division truncates toward zero — JS `/` does not. */
const tdiv = (a: number, b: number): number => Math.trunc(a / b);

/** A calendar date, no time/zone: days since 1970-01-01. */
export class LocalDate {
  readonly kind = 'date' as const;
  constructor(readonly days: number) {}
  /** The ISO-8601 string, e.g. `2020-01-01` — the interop lingua franca. */
  toString(): string {
    return formatDate(this);
  }
  toISOString(): string {
    return formatDate(this);
  }
  toJSON(): { '@date': string } {
    return { '@date': formatDate(this) };
  }
  /** A TC39 `Temporal.PlainDate` (throws if the runtime lacks `Temporal`). */
  toTemporal(): unknown {
    return toTemporalGlobal('PlainDate', formatDate(this));
  }
  /** Parse an ISO date string. */
  static parse(s: string): LocalDate {
    return parseDate(s);
  }
  /** Take the calendar date of a native `Date`, in an explicit zone (default UTC). */
  static fromJSDate(d: Date, opts?: { zone?: 'utc' | 'local' }): LocalDate {
    return new LocalDate(Math.floor(wallMs(d, opts?.zone ?? 'utc') / 86_400_000));
  }
}

/** A zone-less datetime (ISO "LOCAL DATETIME"): secs since the epoch + nanos. */
export class LocalDateTime {
  readonly kind = 'datetime' as const;
  constructor(
    readonly secs: number,
    readonly nanos: number,
  ) {}
  toString(): string {
    return formatDateTime(this);
  }
  toISOString(): string {
    return formatDateTime(this);
  }
  toJSON(): { '@datetime': string } {
    return { '@datetime': formatDateTime(this) };
  }
  /** A TC39 `Temporal.PlainDateTime` (throws if the runtime lacks `Temporal`). */
  toTemporal(): unknown {
    return toTemporalGlobal('PlainDateTime', formatDateTime(this));
  }
  static parse(s: string): LocalDateTime {
    return parseDateTime(s);
  }
  /**
   * Take the wall-clock datetime of a native `Date`, in an explicit zone
   * (default UTC). Explicit because a `Date` is a zoned instant and our types
   * are zone-less — silently guessing a zone would corrupt the stored value.
   */
  static fromJSDate(d: Date, opts?: { zone?: 'utc' | 'local' }): LocalDateTime {
    const ms = wallMs(d, opts?.zone ?? 'utc');
    const secs = Math.floor(ms / 1000);

    return new LocalDateTime(secs, (ms - secs * 1000) * 1_000_000);
  }
}

/** An ISO-8601 calendar duration (months/days kept separate from seconds). */
export class Duration {
  readonly kind = 'duration' as const;
  constructor(
    readonly months: number,
    readonly days: number,
    readonly secs: number,
    readonly nanos: number,
  ) {}
  /** The ISO-8601 duration string, e.g. `P14M3DT4H5M6S`. Round-trips with
   * `Temporal.Duration` / Luxon `Duration.fromISO` — the interop path for
   * durations (JS has no native duration type). */
  toString(): string {
    return formatDuration(this);
  }
  toISOString(): string {
    return formatDuration(this);
  }
  toJSON(): { '@duration': string } {
    return { '@duration': formatDuration(this) };
  }
  /** A TC39 `Temporal.Duration` (throws if the runtime lacks `Temporal`). */
  toTemporal(): unknown {
    return toTemporalGlobal('Duration', formatDuration(this));
  }
  static parse(s: string): Duration {
    return parseDuration(s);
  }
}

export type Temporal = LocalDate | LocalDateTime | Duration;

export const isTemporal = (v: unknown): v is Temporal =>
  v instanceof LocalDate || v instanceof LocalDateTime || v instanceof Duration;

// --- civil calendar (Hinnant) ------------------------------------------------

/** Days since 1970-01-01 for a proleptic-Gregorian (y, m, d). `m` in 1..=12. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = tdiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400;
  const doy = tdiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
  const doe = yoe * 365 + tdiv(yoe, 4) - tdiv(yoe, 100) + doy;

  return era * 146_097 + doe - 719_468;
}

/** Proleptic-Gregorian [y, m, d] for days since 1970-01-01. */
export function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719_468;
  const era = tdiv(zz >= 0 ? zz : zz - 146_096, 146_097);
  const doe = zz - era * 146_097;
  const yoe = tdiv(doe - tdiv(doe, 1460) + tdiv(doe, 36_524) - tdiv(doe, 146_096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + tdiv(yoe, 4) - tdiv(yoe, 100));
  const mp = tdiv(5 * doy + 2, 153);
  const d = doy - tdiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;

  return [m <= 2 ? y + 1 : y, m, d];
}

// --- small helpers -----------------------------------------------------------

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

const parseIntStrict = (s: string): number => {
  if (!/^-?\d+$/.test(s)) {
    throw new Error(`invalid integer '${s}'`);
  }

  return Number(s);
};

/** A fractional-second string (up to 9 digits) → nanoseconds. */
const parseFrac = (frac: string | undefined): number => {
  if (frac === undefined) {
    return 0;
  }

  if (frac.length === 0 || frac.length > 9 || !/^\d+$/.test(frac)) {
    throw new Error(`bad fractional seconds '.${frac}'`);
  }

  return Number(frac.padEnd(9, '0'));
};

/** Render `nanos` as `.fraction` (trailing zeros trimmed), or '' when zero. */
const fmtFrac = (nanos: number): string => {
  if (nanos === 0) {
    return '';
  }

  return `.${pad(nanos, 9).replace(/0+$/, '')}`;
};

/** Parse `HH:MM:SS[.fraction]` into [seconds-of-day, nanos]. */
const parseTime = (s: string): [number, number] => {
  const dot = s.indexOf('.');
  const hms = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? undefined : s.slice(dot + 1);
  const parts = hms.split(':');

  if (parts.length !== 3) {
    throw new Error(`bad time '${s}'`);
  }

  const [h, m, sec] = parts.map(parseIntStrict);

  if (h < 0 || h >= 24 || m < 0 || m >= 60 || sec < 0 || sec >= 60) {
    throw new Error(`time out of range '${s}'`);
  }

  return [h * 3600 + m * 60 + sec, parseFrac(frac)];
};

// --- Date --------------------------------------------------------------------

export function parseDate(s: string): LocalDate {
  const parts = s.split('-');

  if (parts.length !== 3) {
    throw new Error(`bad date '${s}'`);
  }

  const [y, m, d] = parts.map(parseIntStrict);

  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new Error(`date out of range '${s}'`);
  }

  return new LocalDate(daysFromCivil(y, m, d));
}

export function formatDate(dt: LocalDate): string {
  const [y, m, d] = civilFromDays(dt.days);

  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

// --- DateTime ----------------------------------------------------------------

export function parseDateTime(s: string): LocalDateTime {
  const sep = s.search(/[T ]/);

  if (sep === -1) {
    throw new Error(`datetime missing time part '${s}'`);
  }

  const date = parseDate(s.slice(0, sep));
  const [tod, nanos] = parseTime(s.slice(sep + 1));

  return new LocalDateTime(date.days * SECS_PER_DAY + tod, nanos);
}

export function formatDateTime(dt: LocalDateTime): string {
  // Floor-divide so a pre-epoch time-of-day stays in [0, 86400).
  const days = Math.floor(dt.secs / SECS_PER_DAY);
  const tod = ((dt.secs % SECS_PER_DAY) + SECS_PER_DAY) % SECS_PER_DAY;
  const [y, mo, d] = civilFromDays(days);
  const h = tdiv(tod, 3600);
  const m = tdiv(tod % 3600, 60);
  const s = tod % 60;

  return `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${fmtFrac(dt.nanos)}`;
}

// --- Duration ----------------------------------------------------------------

export function parseDuration(s: string): Duration {
  if (!s.startsWith('P')) {
    throw new Error(`duration must start with 'P': '${s}'`);
  }

  const rest = s.slice(1);
  const tIdx = rest.indexOf('T');
  const datePart = tIdx === -1 ? rest : rest.slice(0, tIdx);
  const timePart = tIdx === -1 ? undefined : rest.slice(tIdx + 1);
  let months = 0;
  let days = 0;
  let num = '';
  const takeNum = (designator: string): number => {
    if (num === '') {
      throw new Error(`missing number before '${designator}' in '${s}'`);
    }

    const v = parseIntStrict(num);
    num = '';

    return v;
  };

  for (const c of datePart) {
    if (/[0-9-]/.test(c)) {
      num += c;
    } else if (c === 'Y') {
      months += takeNum('Y') * 12;
    } else if (c === 'M') {
      months += takeNum('M');
    } else if (c === 'W') {
      days += takeNum('W') * 7;
    } else if (c === 'D') {
      days += takeNum('D');
    } else {
      throw new Error(`bad duration date field '${c}' in '${s}'`);
    }
  }

  if (num !== '') {
    throw new Error(`dangling number in duration '${s}'`);
  }

  let secs = 0;
  let nanos = 0;

  if (timePart !== undefined) {
    for (const c of timePart) {
      if (/[0-9.-]/.test(c)) {
        num += c;
      } else if (c === 'H') {
        secs += takeNum('H') * 3600;
      } else if (c === 'M') {
        secs += takeNum('M') * 60;
      } else if (c === 'S') {
        const dot = num.indexOf('.');
        const whole = dot === -1 ? num : num.slice(0, dot);
        const frac = dot === -1 ? undefined : num.slice(dot + 1);

        if (whole === '') {
          throw new Error(`missing number before 'S' in '${s}'`);
        }

        secs += parseIntStrict(whole);
        nanos = parseFrac(frac);
        num = '';
      } else {
        throw new Error(`bad duration time field '${c}' in '${s}'`);
      }
    }

    if (num !== '') {
      throw new Error(`dangling number in duration '${s}'`);
    }
  }

  return new Duration(months, days, secs, nanos);
}

export function formatDuration(d: Duration): string {
  let out = 'P';

  if (d.months !== 0) {
    out += `${d.months}M`;
  }

  if (d.days !== 0) {
    out += `${d.days}D`;
  }

  if (d.secs !== 0 || d.nanos !== 0) {
    out += `T${d.secs}${fmtFrac(d.nanos)}S`;
  }

  return out === 'P' ? 'PT0S' : out;
}

// --- Temporal (kind-agnostic) helpers ----------------------------------------

export const temporalTag = (t: Temporal): 'date' | 'datetime' | 'duration' => t.kind;

export function temporalFormat(t: Temporal): string {
  if (t instanceof LocalDate) {
    return formatDate(t);
  }

  if (t instanceof LocalDateTime) {
    return formatDateTime(t);
  }

  return formatDuration(t);
}

/** Build from a kind tag + ISO string (the codec decode path); throws on error. */
export function temporalParse(tag: string, s: string): Temporal {
  if (tag === 'date') {
    return parseDate(s);
  }

  if (tag === 'datetime') {
    return parseDateTime(s);
  }

  if (tag === 'duration') {
    return parseDuration(s);
  }

  throw new Error(`unknown temporal kind '${tag}'`);
}

/** GraphSON v3 `@type` name (TinkerPop extended types). */
export function graphsonType(t: Temporal): string {
  if (t instanceof LocalDate) {
    return 'gx:LocalDate';
  }

  if (t instanceof LocalDateTime) {
    return 'gx:LocalDateTime';
  }

  return 'gx:Duration';
}

/** GraphSON `@type` → kind tag, or `undefined` if not a temporal type. */
export function graphsonTag(ty: string): 'date' | 'datetime' | 'duration' | undefined {
  if (ty === 'gx:LocalDate') {
    return 'date';
  }

  if (ty === 'gx:LocalDateTime') {
    return 'datetime';
  }

  if (ty === 'gx:Duration') {
    return 'duration';
  }

  return undefined;
}

/** Recognize a single-key tagged temporal object `{"@date":"…"}`, else null. */
export function fromTaggedJson(v: unknown): Temporal | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return null;
  }

  const keys = Object.keys(v);

  if (keys.length !== 1) {
    return null;
  }

  const [key] = keys;

  if (key !== '@date' && key !== '@datetime' && key !== '@duration') {
    return null;
  }

  const s = (v as Record<string, unknown>)[key];

  if (typeof s !== 'string') {
    return null;
  }

  return temporalParse(key.slice(1), s);
}

// --- interop (TC39 Temporal / native Date bridge) ----------------------------

/** Wall-clock ms for a native `Date` in an explicit zone. */
const wallMs = (d: Date, zone: 'utc' | 'local'): number =>
  zone === 'local' ? d.getTime() - d.getTimezoneOffset() * 60_000 : d.getTime();

/** Build a TC39 `Temporal.<kind>` from an ISO string, or throw if unavailable. */
const toTemporalGlobal = (
  kind: 'PlainDate' | 'PlainDateTime' | 'Duration',
  iso: string,
): unknown => {
  const T = (globalThis as unknown as { Temporal?: Record<string, { from(s: string): unknown }> })
    .Temporal;

  if (T === undefined) {
    throw new Error(
      'TC39 Temporal is not available in this runtime — use .toISOString() with your date library',
    );
  }

  return T[kind].from(iso);
};

/** `[object Temporal.PlainDate]` → `Temporal.PlainDate`, else `''`. */
const brandOf = (v: unknown): string => {
  const tag = Object.prototype.toString.call(v);

  return tag.startsWith('[object Temporal.') ? tag.slice(8, -1) : '';
};

/** Strip a Temporal calendar annotation (`[u-ca=iso8601]`) from an ISO string. */
const stripAnnotation = (s: string): string => s.replace(/\[[^\]]*\]/g, '');

/**
 * Coerce a foreign temporal value into lenke's model at the value boundary: a
 * lenke instance passes through; a TC39 `Temporal.PlainDate`/`PlainDateTime`/
 * `Duration` converts via its ISO string. Returns `null` for anything else (the
 * caller decides whether that's an error). A native `Date` deliberately does NOT
 * coerce — it's a zoned instant; use `LocalDateTime.fromJSDate(d, { zone })`.
 */
export function coerceTemporal(v: unknown): Temporal | null {
  if (isTemporal(v)) {
    return v;
  }

  switch (brandOf(v)) {
    case 'Temporal.PlainDate':
      return parseDate(stripAnnotation(String(v)));
    case 'Temporal.PlainDateTime':
      return parseDateTime(stripAnnotation(String(v)));
    case 'Temporal.Duration':
      return parseDuration(stripAnnotation(String(v)));
    default:
      return null;
  }
}

const kindRank = (t: Temporal): number => {
  if (t instanceof LocalDate) {
    return 0;
  }

  if (t instanceof LocalDateTime) {
    return 1;
  }

  return 2;
};

const cmpNum = (a: number, b: number): number => {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
};

const cmpTuple = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const c = cmpNum(a[i], b[i]);

    if (c !== 0) {
      return c;
    }
  }

  return 0;
};

/**
 * Deterministic TOTAL order over all temporals (for `ORDER BY`/min/max): by kind,
 * then chronologically within date/datetime, lexicographically within duration.
 */
export function temporalCmpTotal(a: Temporal, b: Temporal): number {
  if (a instanceof LocalDate && b instanceof LocalDate) {
    return cmpNum(a.days, b.days);
  }

  if (a instanceof LocalDateTime && b instanceof LocalDateTime) {
    return cmpTuple([a.secs, a.nanos], [b.secs, b.nanos]);
  }

  if (a instanceof Duration && b instanceof Duration) {
    return cmpTuple([a.months, a.days, a.secs, a.nanos], [b.months, b.days, b.secs, b.nanos]);
  }

  return cmpNum(kindRank(a), kindRank(b));
}

/**
 * Relational order for `< > <= >=`: date/datetime (same kind) are instants;
 * durations and cross-kind pairs are UNKNOWN (`null`).
 */
export function temporalRelCmp(a: Temporal, b: Temporal): number | null {
  if (a instanceof LocalDate && b instanceof LocalDate) {
    return cmpNum(a.days, b.days);
  }

  if (a instanceof LocalDateTime && b instanceof LocalDateTime) {
    return cmpTuple([a.secs, a.nanos], [b.secs, b.nanos]);
  }

  return null;
}
