import { ErrorCode, PlGraphError } from '@pl-graph/errors';

/**
 * Shared marshalling guards for the two backends. The FFI boundary is *our* seam
 * — both sides are pl-graph code — so these are not defenses against a hostile
 * peer; they are contract checks at a border crossing. A length that can't be
 * trusted or an error report that doesn't match the agreed `{code, message}`
 * shape means our own ABI drifted, and we'd rather surface that as a coded
 * {@link ErrorCode.Ffi} fault than let it silently truncate a buffer or hand back
 * a `PlGraphError` whose `code` is `undefined`.
 */

/** The shape Rust writes into the last-error slot (mirrors `PlGraphError`). */
export type ErrorReport = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | null;
};

/**
 * Coerce a length the crate wrote into `out_len` to a JS array length, checking
 * it's a value we can actually use. `out_len` is a native `usize`; over bun:ffi
 * it arrives as a `bigint` that can exceed `Number.MAX_SAFE_INTEGER` (where
 * `Number()` starts dropping bits). A non-finite, negative, or unsafe length is
 * a broken result contract — throw rather than read a corrupt range.
 */
export const asByteLength = (raw: number | bigint, op: string): number => {
  const len = typeof raw === 'bigint' ? Number(raw) : raw;

  if (!Number.isSafeInteger(len) || len < 0) {
    throw new PlGraphError(
      `pl-graph: ${op}: native returned an implausible buffer length (${String(raw)})`,
      { code: ErrorCode.Ffi, details: { len: String(raw) } },
    );
  }

  return len;
};

/**
 * Parse and shape-check the JSON last-error report the crate hands back. A report
 * that isn't valid JSON, or that lacks the agreed `{code, message}` strings, is
 * itself an FFI fault: return null so the caller falls back to a generic code
 * instead of surfacing a `PlGraphError` whose `code` field is `undefined`.
 */
export const parseErrorReport = (json: string): ErrorReport | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { code?: unknown }).code !== 'string' ||
    typeof (parsed as { message?: unknown }).message !== 'string'
  ) {
    return null;
  }

  return parsed as ErrorReport;
};
