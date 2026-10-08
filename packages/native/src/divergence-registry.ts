/**
 * The DECLARED divergences between the TypeScript and Rust engines.
 *
 * Byte-identity is the development strategy that has caught most of this engine's wrong
 * answers: two independent implementations of one spec, compared on generated input. It is
 * not, however, a product requirement. The engines have different capabilities — the Rust
 * core is 1.5-4x faster on most shapes and ~250x faster per path on the var-length walker,
 * it can take parallelism that a single-threaded JavaScript host cannot, and it does not
 * block an event loop — so there are places where holding one back to match the other buys
 * nothing.
 *
 * This is where those places are written down, and the point of writing them down is that
 * the alternative is what this file replaces: an `if` buried in a fuzzer with a long comment,
 * which nothing audits and nothing notices when it stops being true.
 *
 * # What may and may not be declared
 *
 * An entry names an AXIS. The axes are not a taxonomy of convenience — three of the four are
 * things ISO/IEC 39075 explicitly leaves to the implementation, and the fourth is a property
 * of floating-point arithmetic:
 *
 * - `resource` — WHICH queries hit a limit. The engines pay different amounts for the same
 *   work, so the same budget cuts in different places.
 * - `evaluation-order` — whether an exception is raised from an INESSENTIAL part of an
 *   expression. ISO `US008` (actual order of expression evaluation) and `UA004` (whether an
 *   exception is raised from an inessential part) both make this implementation-dependent.
 * - `order` — the sequence of records in an unordered binding table. ISO `US001`.
 * - `float-reduction` — the association order of a floating-point reduction, which a parallel
 *   sum changes. Bounded: the result differs in the last places, not arbitrarily.
 *
 * There is deliberately NO `value` axis, and `accept` refuses a value divergence whatever the
 * registry says. If the engines disagree about the answer to a determinate question, that is a
 * bug in one of them, and no entry may excuse it. That rule is what keeps this file from
 * becoming a way to turn red into green.
 *
 * # What an entry must be
 *
 * NARROW and MONITORED. Narrow: `matches` should pin the shape AND the magnitude, so the small
 * cases still have to agree exactly and only the pathological tail is excused — a registry
 * entry that matches a whole operator is a bug being hidden. Monitored: usage is tracked, and
 * `unused` reports an entry that nothing exercised, so an entry cannot outlive the behaviour
 * it describes.
 *
 * Being FIXABLE disqualifies an entry. The var-length count asymmetry looked like a resource
 * divergence and was a misaligned guard (audit item 78); the `CALL`-body case looks like an
 * evaluation-order divergence and is a laziness bug. Both would have been wrong to declare.
 */

/** One engine's outcome for one query. */
export type Outcome = { ok: true; json: string } | { ok: false; code: string };

/** The axes along which a declared divergence may sit. `value` is deliberately not one. */
export type Axis = 'resource' | 'evaluation-order' | 'order' | 'float-reduction';

/** What a difference actually IS, as classified from the two outcomes. */
export type Observed = Axis | 'value';

/** A query and what each engine did with it. */
export type DivergenceCase = {
  query: string;
  ts: Outcome;
  native: Outcome;
};

/**
 * Which engine is allowed to be the PERMISSIVE side — the one that answers where the other
 * refuses, or does not raise where the other does. `either` is for axes with no permissive
 * side (`order`, `float-reduction`).
 */
export type Direction = 'native-permits' | 'ts-permits' | 'either';

export type Entry = {
  /** Stable kebab-case id; appears in the harness output when an entry is used. */
  id: string;
  axis: Axis;
  direction: Direction;
  /** Why this is a legitimate difference and not a bug. Prose, for a human auditing the list. */
  reason: string;
  /** Where the decision is recorded — an audit item, so the reasoning is traceable. */
  recorded: string;
  /**
   * True when a DETERMINISTIC suite is expected to exercise this every run, so `unused` can
   * treat an unexercised entry as a failure. A random-seeded fuzzer cannot promise that, so
   * entries only reachable there leave it false.
   */
  deterministic?: boolean;
  /** The shape AND magnitude this entry covers. Narrow is the whole point. */
  matches: (c: DivergenceCase) => boolean;
};

const isEmptyResult = (o: Outcome): boolean => o.ok && (o.json === '[]' || o.json === '');

const erroredWith = (o: Outcome, code: string): boolean => !o.ok && o.code === code;

/** The error codes that mean "this engine declined to do the work", not "this input is bad". */
const RESOURCE_CODES: ReadonlySet<string> = new Set(['E_RESOURCE_EXHAUSTED']);

const isResourceError = (o: Outcome): boolean => !o.ok && RESOURCE_CODES.has(o.code);

/**
 * Parse a JSON array of row objects into a canonical multiset key per row, so two results can
 * be compared ignoring ROW ORDER. Returns null when either side is not an array of objects,
 * in which case the caller cannot claim an ordering difference.
 */
const rowMultiset = (json: string): string[] | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  return parsed.map((row) => JSON.stringify(row)).sort();
};

const sameMultiset = (a: string, b: string): boolean => {
  const ra = rowMultiset(a);
  const rb = rowMultiset(b);

  if (ra === null || rb === null || ra.length !== rb.length) {
    return false;
  }

  return ra.every((row, i) => row === rb[i]);
};

/**
 * Do the two results differ ONLY in the last places of some number? A parallel reduction
 * reassociates a sum, which moves the result by an ulp or two and changes nothing else.
 *
 * Compared structurally rather than textually: same shape, same keys, every non-numeric leaf
 * equal, and every numeric leaf within a relative tolerance.
 */
const ULP_TOLERANCE = 1e-12;

const nearlyEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) {
      return true;
    }

    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return a === b;
    }

    const scale = Math.max(Math.abs(a), Math.abs(b), 1);

    return Math.abs(a - b) <= ULP_TOLERANCE * scale;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => nearlyEqual(x, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();

    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i]) &&
      ka.every((k) =>
        nearlyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  }

  return a === b;
};

const differsOnlyInFloatTail = (a: string, b: string): boolean => {
  try {
    const pa: unknown = JSON.parse(a);
    const pb: unknown = JSON.parse(b);

    // An EXACT match is not a float-tail difference; the caller only asks about a known
    // difference, but guard anyway so this cannot classify a non-divergence.
    return JSON.stringify(pa) !== JSON.stringify(pb) && nearlyEqual(pa, pb);
  } catch {
    return false;
  }
};

/**
 * What KIND of difference is this? The classifier answers the kind; it does NOT answer whether
 * the kind is acceptable here — that is the entry's `matches`, which is where narrowness lives.
 *
 * Note that a one-sided NON-resource error classifies as `evaluation-order` whether it is the
 * accepted boolean-context residual (error against an EMPTY result) or a laziness bug (error
 * against ROWS). The classifier cannot tell those apart and should not try: the difference is
 * the magnitude of what the permissive side returned, which an entry pins.
 */
export const classify = (c: DivergenceCase): Observed => {
  if (c.ts.ok && c.native.ok) {
    if (c.ts.json === c.native.json) {
      return 'value'; // not a divergence at all; caller should not have asked
    }

    if (sameMultiset(c.ts.json, c.native.json)) {
      return 'order';
    }

    if (differsOnlyInFloatTail(c.ts.json, c.native.json)) {
      return 'float-reduction';
    }

    return 'value';
  }

  if (!c.ts.ok && !c.native.ok) {
    // Both refused. Different codes is a semantic disagreement about WHY, which is a value
    // question, not a capability one.
    return c.ts.code === c.native.code ? 'value' : 'value';
  }

  // Exactly one side refused.
  return isResourceError(c.ts) || isResourceError(c.native) ? 'resource' : 'evaluation-order';
};

/** Which side answered / did not raise, for the direction check. */
const permissiveSide = (c: DivergenceCase): 'native' | 'ts' | 'both' => {
  if (c.ts.ok && !c.native.ok) {
    return 'ts';
  }

  if (c.native.ok && !c.ts.ok) {
    return 'native';
  }

  return 'both';
};

const directionAllows = (entry: Entry, c: DivergenceCase): boolean => {
  if (entry.direction === 'either') {
    return true;
  }

  const side = permissiveSide(c);

  if (side === 'both') {
    // No permissive side to speak of (both answered), so a directional entry does not apply.
    return false;
  }

  return entry.direction === (side === 'native' ? 'native-permits' : 'ts-permits');
};

export type Verdict =
  | { accepted: true; by: string; axis: Axis }
  | { accepted: false; observed: Observed; why: string };

const usage = new Map<string, number>();

/** How many times each entry has been used since the last `resetUsage`. */
export const usageCounts = (): ReadonlyMap<string, number> => new Map(usage);

export const resetUsage = (): void => {
  usage.clear();
};

/**
 * Entries that nothing exercised. An entry that stops matching has outlived the behaviour it
 * describes and should be deleted, so a deterministic suite can assert this is empty.
 * `deterministicOnly` limits it to the entries that promise to be reachable every run.
 */
export const unused = (deterministicOnly = true): string[] =>
  REGISTRY.filter((e) => (deterministicOnly ? e.deterministic === true : true))
    .filter((e) => (usage.get(e.id) ?? 0) === 0)
    .map((e) => e.id);

/**
 * Is this difference one we have declared? Returns the entry that covers it, or why not.
 *
 * A `value` difference is refused unconditionally — before the registry is even consulted —
 * because no entry may excuse the engines disagreeing about an answer.
 */
export const accept = (c: DivergenceCase): Verdict => {
  const observed = classify(c);

  if (observed === 'value') {
    return {
      accepted: false,
      observed,
      why:
        'the engines disagree about the ANSWER, which no registry entry may excuse — ' +
        'a value divergence is a bug in one of them',
    };
  }

  for (const entry of REGISTRY) {
    if (entry.axis !== observed) {
      continue;
    }

    if (!directionAllows(entry, c)) {
      continue;
    }

    if (!entry.matches(c)) {
      continue;
    }

    usage.set(entry.id, (usage.get(entry.id) ?? 0) + 1);

    return { accepted: true, by: entry.id, axis: entry.axis };
  }

  return {
    accepted: false,
    observed,
    why:
      `${observed === 'evaluation-order' || observed === 'order' ? 'an' : 'a'} ${observed} ` +
      'difference, but no registry entry covers this shape',
  };
};

/**
 * THE DECLARED DIVERGENCES.
 *
 * Keep this list short and keep every entry narrow. Adding one is a decision about the
 * product, not a way to make a suite pass — see the header, and record the reasoning in the
 * audit before adding.
 */
export const REGISTRY: readonly Entry[] = [
  {
    id: 'boolean-context-dynamic-operand-under-seek',
    axis: 'evaluation-order',
    direction: 'either',
    recorded: 'docs/reviews/2026-08-31-ts-audit.md, boolean-context static check',
    reason:
      'Both engines run the same STATIC (plan-time) boolean-context type check, so a ' +
      'statically non-boolean value in a truth position is rejected before execution by ' +
      'both. What is left is a DYNAMICALLY typed operand (a bare property, `NOT n.s`, an ' +
      'unclassified function result) AND-ed with a comparison, where the comparison ' +
      'eliminates every row BY A ROUTE THE OTHER ENGINE DOES NOT HAVE. Two such routes ' +
      'survive, and both are about ORDER rather than about the connective: (1) the ' +
      'comparison is UNKNOWN on every row — a filter keeps only TRUE, so native drops the ' +
      'row, while Kleene `AND` does not settle on UNKNOWN and reaches the operand; (2) the ' +
      'comparison is written AFTER the raising operand and native’s seek hoists it out of ' +
      'the chain, which the TS engine has no seek to match. ISO US008/UA004 make both ' +
      'outcomes conformant. Fixing either means abandoning the seek, which is not ' +
      'perf-neutral. ' +
      'NARROWED on 2026-10-08: `AND` now short-circuits on FALSE in both engines, so the ' +
      'whole class where the comparison is simply FALSE on every row — which was most of ' +
      'this entry’s traffic — is FIXED and no longer declared. Measured on the differential ' +
      'fuzzer at 20,000 queries a run: ~4 uses a run before, ~1 after.',
    // NARROW: always `E_INVALID_VALUE` on one side against an EMPTY result on the other.
    // "Malformed predicate" against "no rows" — never wrong data, and never rows. An error
    // against a NON-EMPTY result is a different thing entirely (that is the `CALL`-body
    // laziness bug) and is NOT covered here.
    matches: (c) =>
      (erroredWith(c.ts, 'E_INVALID_VALUE') && isEmptyResult(c.native)) ||
      (erroredWith(c.native, 'E_INVALID_VALUE') && isEmptyResult(c.ts)),
  },
];
