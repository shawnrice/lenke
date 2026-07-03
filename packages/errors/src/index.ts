/**
 * Canonical, stable error codes for the lenke packages.
 *
 * The **code is the contract**, not the message. Consumers should branch on
 * `error.code` (or {@link hasErrorCode}) rather than matching message text, so a
 * reworded or typo-fixed message is never a breaking change. Codes are opaque
 * strings (`E_*`); never reuse or repurpose a value once shipped.
 */
export const ErrorCode = {
  /** A query/text parse or lex failure (GQL / Gremlin / `.pg`). */
  Syntax: 'E_SYNTAX',
  /** Input wasn't valid JSON. */
  InvalidJson: 'E_INVALID_JSON',
  /** Input parsed but didn't match the expected document shape. */
  InvalidShape: 'E_INVALID_SHAPE',
  /** An unknown serialization format name. */
  UnknownFormat: 'E_UNKNOWN_FORMAT',
  /** A value outside the LPG property-value model. */
  InvalidValue: 'E_INVALID_VALUE',
  /** An ISO data exception at evaluation time (division by zero, a type
   * mismatch in an operation, a numeric value out of range). */
  DataException: 'E_DATA_EXCEPTION',
  /** An edge (or operation) referenced a vertex id that doesn't exist. */
  MissingVertex: 'E_MISSING_VERTEX',
  /** An invalid graph mutation (e.g. a cycle, a self-reference). */
  InvalidGraphOp: 'E_INVALID_GRAPH_OP',
  /** An invalid tree structure or operation. */
  InvalidTree: 'E_INVALID_TREE',
  /** A recognized-but-not-yet-implemented feature. */
  NotImplemented: 'E_NOT_IMPLEMENTED',
  /** A feature/clause/predicate that isn't supported. */
  Unsupported: 'E_UNSUPPORTED',
  /** Evaluation hit a resource limit (e.g. a variable-length pattern whose path
   * enumeration exceeded the trail budget). Tighten the pattern (add a bound) or
   * raise the limit. */
  ResourceExhausted: 'E_RESOURCE_EXHAUSTED',
  /** An unknown function/step/symbol referenced in a query. */
  UnknownFunction: 'E_UNKNOWN_FUNCTION',
  /** A failure crossing the native/wasm FFI boundary. */
  Ffi: 'E_FFI',
} as const;

/**
 * The set of canonical error-code values. Derived from {@link ErrorCode} so the
 * object and the type can't drift — adding a member widens the union for free.
 * (Same name as the value: `ErrorCode` is usable in both type and value position,
 * mirroring an enum's ergonomics without an enum's footguns.)
 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type LenkeErrorOptions = {
  readonly code: ErrorCode;
  /** The underlying error, attached as the standard `Error.cause`. */
  readonly cause?: unknown;
  /** Structured context for the failure (ids, positions, format names, …). */
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * Base error carrying a stable {@link ErrorCode}. Subclass it (or set a matching
 * `code` field) when a package wants a more specific error type while staying
 * matchable via {@link hasErrorCode}.
 */
export class LenkeError extends Error {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(message: string, options: LenkeErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LenkeError';
    this.code = options.code;
    this.details = options.details;
  }
}

/** Type guard for {@link LenkeError}. */
export const isLenkeError = (error: unknown): error is LenkeError => error instanceof LenkeError;

/**
 * True if `error` carries the given stable `code`. Works for any error with a
 * `code` field (a {@link LenkeError}, a subclass, or any object that adopts the
 * convention) — match on this rather than on message text.
 */
export const hasErrorCode = (error: unknown, code: ErrorCode): boolean =>
  typeof error === 'object' && (error as { code?: unknown })?.code === code;
