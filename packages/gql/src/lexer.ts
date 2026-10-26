/**
 * Hand-written lexer for the GQL subset. Turns query text into a flat token
 * stream the parser consumes. This is the layer the gremlin package never
 * needed — its "queries" are TypeScript function calls, so there was nothing to
 * tokenize. A textual language has to start here.
 *
 * Design notes:
 *  - Multi-char operators are matched greedily so `<>`, `<=`, `>=`, `->` and
 *    `<-` win over their single-char prefixes. The parser reassembles arrows
 *    and dashes into relationship directions.
 *  - Keywords are case-insensitive (`MATCH` == `match`); identifiers and string
 *    literals keep their original case.
 */

import { ErrorCode, LenkeError } from '@lenke/errors';

export type TokenType =
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'lbrace'
  | 'rbrace'
  | 'colon'
  | 'dot'
  | 'comma'
  | 'pipe' // |  (label disjunction)
  | 'amp' // &  (label conjunction)
  | 'bang' // !  (label negation)
  | 'percent' // %  (label wildcard / modulo)
  | 'plus' // +
  | 'star' // *
  | 'slash' // /
  | 'concat' // ||
  | 'dash' // -
  | 'rarrow' // ->
  | 'larrow' // <-
  | 'tilde' // ~  (undirected)
  | 'ltilde' // <~
  | 'tilder' // ~>
  | 'lrarrow' // <->
  | 'eq' // =
  | 'neq' // <>
  | 'lt' // <
  | 'gt' // >
  | 'lte' // <=
  | 'gte' // >=
  | 'number'
  | 'string'
  | 'param' // $name
  | 'ident'
  | 'keyword'
  | 'eof';

export type Token = {
  type: TokenType;
  /** Original source text (for identifiers/strings) or the keyword, lowercased. */
  value: string;
  /**
   * The verbatim source text with original casing preserved. Only set for
   * `keyword` tokens (whose `value` is lowercased for structural matching) — the
   * parser needs it to echo the user's exact spelling when suggesting the
   * backtick-delimited form of a reserved word (`` `Order` ``, not `` `order` ``).
   */
  raw?: string;
  /** Number value, only set for `number` tokens. */
  num?: number;
  /** True for a backtick-delimited identifier — may be any word, even reserved. */
  delimited?: boolean;
  /** Zero-based offset in the source, for error messages. */
  pos: number;
};

const KEYWORDS = new Set([
  'match',
  'optional',
  'with',
  'where',
  'let',
  'filter',
  'next',
  'call',
  'yield',
  'insert',
  'set',
  'remove',
  'delete',
  'detach',
  'nodetach',
  'finish',
  'return',
  'for',
  'as',
  'is',
  'in',
  'and',
  'or',
  'xor',
  'not',
  'distinct',
  'all',
  'any',
  'shortest',
  'case',
  'when',
  'then',
  'else',
  'end',
  'exists',
  'count',
  'nulls',
  'unknown',
  'limit',
  'union',
  'except',
  'intersect',
  'order',
  'by',
  'asc',
  'ascending',
  'desc',
  'descending',
  'skip',
  'offset',
  'true',
  'false',
  'null',
]);

/**
 * The complete ISO/IEC 39075 reserved-word list (`<reserved word>` plus
 * `<pre-reserved word>`). A reserved word may not be used as a bare identifier
 * (variable, label, property key, alias) — only as a function name in call
 * position or as a delimited identifier. `KEYWORDS` above is the structural
 * subset the parser dispatches on; this is the full set the parser uses to
 * reject identifiers. Verbatim from the standard so the list can't drift.
 */
const RESERVED = new Set<string>(
  (
    'abs acos all all_different and any array as asc ascending asin at atan atan2 avg big bigint ' +
    'binary bool boolean both btrim by byte_length bytes call cardinality case cast ceil ceiling ' +
    'char char_length character_length characteristics close coalesce collect_list commit copy cos ' +
    'cosh cot count create current_date current_graph current_property_graph current_schema ' +
    'current_time current_timestamp date datetime day dec decimal degrees delete desc descending ' +
    'detach distinct double drop duration duration_between element_id else end except exists exp ' +
    'false filter finish float float16 float32 float64 float128 float256 floor for from group having ' +
    'home_graph home_property_graph home_schema hour if implies in insert int integer int8 integer8 ' +
    'int16 integer16 int32 integer32 int64 integer64 int128 integer128 int256 integer256 intersect ' +
    'interval is leading left let like limit list ln local local_datetime local_time ' +
    'local_timestamp log log10 lower ltrim match max min minute mod month next nodetach normalize ' +
    'not nothing null nulls nullif octet_length of offset optional or order otherwise parameter ' +
    'parameters path path_length paths percentile_cont percentile_disc power precision ' +
    'property_exists radians real record remove replace reset return right rollback rtrim same ' +
    'schema second select session session_user set signed sin sinh size skip small smallint sqrt ' +
    'start stddev_pop stddev_samp string sum tan tanh then time timestamp trailing trim true typed ' +
    'ubigint uint uint8 uint16 uint32 uint64 uint128 uint256 union unknown unsigned upper use ' +
    'usmallint value varbinary varchar variable when where with xor year yield zoned zoned_datetime ' +
    'zoned_time ' +
    // <pre-reserved word> (reserved for future use)
    'abstract aggregate aggregates alter catalog clear clone constraint current_role current_user ' +
    'data directory dryrun exact existing function gqlstatus grant instant infinity number numeric ' +
    'on open partition procedure product project query records reference rename revoke substring ' +
    'system_user temporal unique unit values whitespace'
  ).split(' '),
);

/** Is `word` (case-insensitive) an ISO reserved word, hence not a bare identifier? */
export const isReserved = (word: string): boolean => RESERVED.has(word.toLowerCase());

// A bare (un-delimited) identifier: an ASCII letter/underscore start, then
// letters/digits/underscores. Conservative — anything outside this (spaces,
// dots, punctuation, leading digit, non-ASCII) must be a delimited identifier.
const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote `ident` (a label, property key, alias, or variable) for safe splicing
 * into a GQL query. A reserved word (`order`, `value`) or a name that isn't a
 * valid bare identifier (spaces, dots, punctuation, …) becomes a backtick-
 * delimited identifier, with any internal backtick doubled (`` `a``b` ``); a
 * plain non-reserved name is returned unchanged. The result is always a valid,
 * inert identifier — the counterpart to `$param` binding for values.
 */
export const quoteIdent = (ident: string): string =>
  BARE_IDENT.test(ident) && !isReserved(ident) ? ident : `\`${ident.replace(/`/g, '``')}\``;

const isDigit = (c: string): boolean => c >= '0' && c <= '9';

// Valid digits per integer base: hex `0x`, octal `0o`, binary `0b`. Sharing one
// class let invalid literals like `0b1019AF` / `0o789` lex as a single token
// that then collapsed to NaN.
const BASE_DIGIT_CLASS: Record<string, RegExp> = {
  x: /[0-9a-fA-F_]/,
  o: /[0-7_]/,
  b: /[01_]/,
};
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
// THE IDENTIFIER-CHARACTER CLASS, ON A CHARACTER CODE (item 886).
//
// This replaced a string version (`isIdentStart(c) || isDigit(c)`) that took a one-character
// STRING and did up to four string range comparisons. Item 886's census says identifier
// characters are 46-60% of a realistic query, so the loop that calls this carries more
// characters than any other path in the tokenizer. `charCodeAt` compares integers and allocates
// nothing, where `src[i]` produces a single-character string per character.
//
// `isIdentStart` and `isDigit` above keep their string form: they are called on a character the
// dispatch already has in hand, once per TOKEN rather than once per character.
const CC_0 = 48;
const CC_9 = 57;
const CC_A = 65;
const CC_Z = 90;
const CC_LOWER_A = 97;
const CC_LOWER_Z = 122;
const CC_UNDERSCORE = 95;

// BIT 0x20 DISTINGUISHES CASE, AND WITHIN THE IDENTIFIER CLASS THAT IS EXACT (item 888).
//
// ASCII sets bit 0x20 on lowercase letters and clears it on uppercase. That is NOT a general
// case test — plenty of characters outside this class have the bit clear — but the identifier
// class is only `[A-Za-z0-9_]`, and across exactly those characters bit 0x20 is clear if and
// only if the character is an UPPERCASE LETTER:
//
//     'a' 0x61 set    'A' 0x41 CLEAR    '0' 0x30 set    '_' 0x5f set
//     'z' 0x7a set    'Z' 0x5a CLEAR    '9' 0x39 set
//
// So ANDing every character's code together and testing one bit says whether the identifier
// contains an uppercase letter, at the cost of one `&` per character and no branch. Item 888
// needs that because of the next comment.
const CASE_BIT = 0x20;

// Keywords by their ALL-UPPERCASE spelling, to the canonical lowercase the parser dispatches on.
//
// Proving a word IS a keyword is a set lookup; proving it is NOT requires normalizing it, which is
// why `toLowerCase()` used to run on EVERY identifier — 33 of the 60 tokens in the benchmark's
// big statement. Item 888's ablation priced removing it at 1.24-1.26x of the tokenizer.
//
// Two observations make it avoidable. If an identifier contains NO uppercase letter then it
// already IS its own lowercasing, so `KEYWORDS.has(text)` is the complete answer. And if it is
// written in ALL CAPS — which is how keywords are conventionally spelled — this map answers
// without allocating. Only a MIXED-case word (`MaTcH`, `userName`) falls back to `toLowerCase`.
const KEYWORDS_UPPER = new Map<string, string>();

for (const kw of KEYWORDS) {
  KEYWORDS_UPPER.set(kw.toUpperCase(), kw);
}

const isIdentPartCode = (k: number): boolean =>
  (k >= CC_LOWER_A && k <= CC_LOWER_Z) ||
  (k >= CC_A && k <= CC_Z) ||
  (k >= CC_0 && k <= CC_9) ||
  k === CC_UNDERSCORE;

/** The ISO/IEC 39075 single-character string escapes (besides the quote forms). */
const SIMPLE_ESCAPES: Record<string, string> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  t: '\t',
  n: '\n',
  r: '\r',
  b: '\b',
  f: '\f',
};

/**
 * Decode the backslash escape beginning at `src[i]` (the backslash). Handles the
 * ISO simple escapes plus `\\uXXXX` / `\\UXXXXXX` Unicode escapes; an unknown
 * escape yields the escaped character verbatim. Returns the decoded text and the
 * index just past the escape.
 */
const readEscape = (src: string, i: number): { text: string; next: number } => {
  const esc = src[i + 1];
  const simple = SIMPLE_ESCAPES[esc];

  if (simple !== undefined) {
    return { text: simple, next: i + 2 };
  }

  if (esc === 'u' || esc === 'U') {
    const width = esc === 'u' ? 4 : 6;
    const hex = src.slice(i + 2, i + 2 + width);

    if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new GqlSyntaxError(`Invalid \\${esc} escape (expected ${width} hex digits)`, i);
    }

    return { text: String.fromCodePoint(parseInt(hex, 16)), next: i + 2 + width };
  }

  return { text: esc, next: i + 2 };
};

// THE TWO OPERATOR TABLES, AT MODULE SCOPE (item 885).
//
// Both used to be object literals declared INSIDE the per-character loop, so tokenizing a query
// allocated an 8-key object AND a 20-key object for EVERY CHARACTER. They are pure data with no
// capture, so hoisting them changes allocation and nothing else.
//
// Item 884 measured the TS parser at 64.2 ns a character against native's 22.4, uniform across
// three input sizes — so the cost was per-character work, and this is some of that work.
const TWO_CHAR: Readonly<Record<string, TokenType>> = {
  '->': 'rarrow',
  '<-': 'larrow',
  '<~': 'ltilde',
  '~>': 'tilder',
  '<>': 'neq',
  '<=': 'lte',
  '>=': 'gte',
  '||': 'concat',
};

const SINGLE: Readonly<Record<string, TokenType>> = {
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  '{': 'lbrace',
  '}': 'rbrace',
  ':': 'colon',
  '.': 'dot',
  ',': 'comma',
  '|': 'pipe',
  '&': 'amp',
  '!': 'bang',
  '%': 'percent',
  '+': 'plus',
  '*': 'star',
  '/': 'slash',
  '-': 'dash',
  '~': 'tilde',
  '=': 'eq',
  '<': 'lt',
  '>': 'gt',
};

/**
 * Whether `c` can BEGIN a two- or three-character token — a comment opener (`//`, `--`, `/*`), one
 * of `TWO_CHAR`'s keys, or `<->`.
 *
 * Only for these does the scanner need to look ahead, and looking ahead means building a short
 * string. Gating on this keeps that allocation off the common path — letters, digits and spaces,
 * which are most of a query.
 */
const startsMulti = (c: string): boolean =>
  c === '/' || c === '-' || c === '<' || c === '>' || c === '~' || c === '|';

// A hand-written scanner: one long switch over source characters. Splitting it
// would scatter the token rules and hurt readability more than the length costs.
// eslint-disable-next-line complexity, max-statements
export const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

  // REJECTED, item 888: do NOT stop building this object, or make `num` conditional to shrink it.
  // A ceiling ablation that pushed one shared CONSTANT instead of a fresh token — as wrong as code
  // gets, so a hard upper bound — measured only 1.07x on a token-dense statement and 1.03x on a
  // token-sparse one, against the tokenizer, which is itself 28-54% of parse (item 887). Making
  // `num` conditional would also give tokens two hidden classes, and polymorphic shape has
  // measured as a loss here repeatedly. The 1.24x lever in this function was the keyword lookup
  // above, not this allocation.
  const push = (type: TokenType, value: string, pos: number, num?: number): void => {
    tokens.push({ type, value, pos, num });
  };

  while (i < src.length) {
    const c = src[i];

    // Whitespace.
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    // Only build the lookahead string when this character can START a multi-character token.
    const two = startsMulti(c) ? src.slice(i, i + 2) : '';

    // Comments (ISO/IEC 39075 §5.2): `//` and `--` line comments, `/* */`
    // block comments. Note `--` is a comment, NOT an undirected edge — that is
    // the main divergence from Cypher, where `--` means an undirected
    // relationship.
    if (two === '//' || two === '--') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
      }

      continue;
    }

    if (two === '/*') {
      i += 2;

      while (i < src.length && src.slice(i, i + 2) !== '*/') {
        i += 1;
      }

      if (i >= src.length) {
        throw new GqlSyntaxError('Unterminated block comment', i);
      }

      i += 2; // closing */
      continue;
    }

    // Three-char operators (greedy: `<->` must beat `<-` and `<`).
    if (c === '<' && src.slice(i, i + 3) === '<->') {
      push('lrarrow', '<->', i);
      i += 3;
      continue;
    }

    // Two-char operators (table hoisted to module scope — see TWO_CHAR).
    const twoType = two === '' ? undefined : TWO_CHAR[two];

    if (twoType) {
      push(twoType, two, i);
      i += 2;
      continue;
    }

    // Single-char punctuation/operators (table hoisted to module scope — see SINGLE).
    // A `.` immediately followed by a digit is a leading-dot float (`.5`), not
    // the property-access dot — let it fall through to the number scanner below.
    const dotNumber = c === '.' && isDigit(src[i + 1] ?? '');
    const singleType = dotNumber ? undefined : SINGLE[c];

    if (singleType) {
      push(singleType, c, i);
      i += 1;
      continue;
    }

    // String literals: single or double quoted.
    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      i += 1;

      // THE COMMON CASE IS ONE SLICE (item 886). The old loop appended `src[i]` per character,
      // so a 20-character literal did 20 string concatenations and built 20 single-character
      // strings. Item 886's census puts string-literal characters at 3-12% of the benchmark
      // fixtures but 49.7% of ordinary string-heavy application query text, so this is not a
      // negligible path — it is only a fixture-dependent one.
      //
      // Scan to the closing quote first. With no backslash in between, the value IS the span,
      // and `readEscape` never needs to run.
      const bodyStart = i;

      while (i < src.length && src[i] !== quote && src[i] !== '\\') {
        i += 1;
      }

      let str = src.slice(bodyStart, i);

      // Only a literal that actually contains an escape pays the per-character path, and only
      // from the first backslash onwards.
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const { text, next } = readEscape(src, i);
          str += text;
          i = next;
          continue;
        }

        str += src[i];
        i += 1;
      }

      if (i >= src.length) {
        throw new GqlSyntaxError('Unterminated string literal', start);
      }

      i += 1; // closing quote
      push('string', str, start);
      continue;
    }

    // Delimited identifier: `` `odd name` `` — keeps its exact spelling and is
    // never a keyword. A backtick inside is written doubled (`` `a``b` `` → a`b),
    // the ISO/SQL delimiter-escape convention, so any string can round-trip.
    if (c === '`') {
      const start = i;
      i += 1;
      let name = '';

      while (i < src.length) {
        if (src[i] === '`') {
          if (src[i + 1] === '`') {
            name += '`'; // escaped backtick (doubled)
            i += 2;
            continue;
          }

          break; // a lone backtick closes the identifier
        }

        name += src[i];
        i += 1;
      }

      if (i >= src.length) {
        throw new GqlSyntaxError('Unterminated delimited identifier', start);
      }

      i += 1; // closing backtick
      tokens.push({ type: 'ident', value: name, pos: start, delimited: true });
      continue;
    }

    // Parameters: `$name`.
    if (c === '$') {
      const start = i;
      i += 1;
      const nameStart = i;

      while (i < src.length && isIdentPartCode(src.charCodeAt(i))) {
        i += 1;
      }

      if (i === nameStart) {
        throw new GqlSyntaxError('Expected a parameter name after `$`', start);
      }

      push('param', src.slice(nameStart, i), start);
      continue;
    }

    // Numbers: decimal (with optional fraction/exponent/underscores) and
    // 0x/0o/0b integer bases.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      const afterZero = src[i + 1];
      // Guard against the `''.includes('') === true` quirk: a bare `0` at EOF
      // must not be mistaken for a base prefix.
      const isBasePrefix = c === '0' && afterZero !== undefined && 'xXoObB'.includes(afterZero);

      if (isBasePrefix) {
        const digitClass = BASE_DIGIT_CLASS[afterZero.toLowerCase()] ?? BASE_DIGIT_CLASS.b;
        i += 2;
        const digitsStart = i;

        while (i < src.length && digitClass.test(src[i])) {
          i += 1;
        }

        if (i === digitsStart) {
          throw new GqlSyntaxError(`Malformed numeric literal '${src.slice(start, i)}'`, start);
        }
      } else {
        const digits = (): void => {
          while (i < src.length && /[0-9_]/.test(src[i])) {
            i += 1;
          }
        };
        digits();

        if (src[i] === '.') {
          i += 1;
          digits();
        }

        if (src[i] === 'e' || src[i] === 'E') {
          i += 1;

          if (src[i] === '+' || src[i] === '-') {
            i += 1;
          }

          digits();
        }
      }

      const text = src.slice(start, i);
      const num = Number(text.replace(/_/g, ''));

      // A malformed mantissa (`1e`, `0x`) coerces to NaN — that is a genuine syntax
      // error, so reject it. An overflowing magnitude (`1e999`) coerces to Infinity, and
      // a large integer past 2^53 (`9007199254740993`) rounds to the nearest double: both
      // are ACCEPTED. The numeric model is f64 with no bigint — values leave lenke only as
      // JSON (a JS number) or Arrow, never boxed to preserve exact large integers — so a
      // literal that differs from its text is just the f64 contract (like `0.1 + 0.2`).
      // Infinity is a live value here (nulled only at JSON egress; `1e999 IS NULL` is
      // false), matching the engine. Only NaN is unrepresentable and rejected.
      if (Number.isNaN(num)) {
        throw new GqlSyntaxError(`Malformed numeric literal '${text}'`, start);
      }

      push('number', text, start, num);
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c)) {
      const start = i;

      // The hottest loop in the tokenizer — item 886's census puts 46-60% of a query's
      // characters here. On codes, so it neither allocates a single-character string per
      // character nor does string range comparisons.
      //
      // `caseAcc` ANDs every character's code together; see CASE_BIT. After the loop,
      // `caseAcc & CASE_BIT` is set if and only if NO character was an uppercase letter.
      let caseAcc = CASE_BIT;

      while (i < src.length && isIdentPartCode(src.charCodeAt(i))) {
        caseAcc &= src.charCodeAt(i);
        i += 1;
      }

      const text = src.slice(start, i);
      // Resolve the keyword WITHOUT normalizing where possible — see KEYWORDS_UPPER.
      //   all lowercase  -> the text is its own lowercasing, so one set lookup settles it
      //   all uppercase  -> one map lookup settles it
      //   mixed case     -> normalize, the only case that allocates
      let lower: string | undefined;

      if ((caseAcc & CASE_BIT) !== 0) {
        lower = KEYWORDS.has(text) ? text : undefined;
      } else {
        lower = KEYWORDS_UPPER.get(text);

        if (lower === undefined) {
          const normalized = text.toLowerCase();

          lower = KEYWORDS.has(normalized) ? normalized : undefined;
        }
      }

      if (lower !== undefined) {
        // Keep `value` lowercased so the parser can dispatch on it, but carry the
        // original casing in `raw` so a reserved-word rejection can suggest the
        // user's exact spelling as a delimited identifier.
        tokens.push({ type: 'keyword', value: lower, raw: text, pos: start });
      } else {
        push('ident', text, start);
      }

      continue;
    }

    throw new GqlSyntaxError(`Unexpected character '${c}'`, i);
  }

  push('eof', '', src.length);

  return tokens;
};

/**
 * Thrown for both lex and parse errors, carrying the source offset. Extends
 * `LenkeError` with the stable `ErrorCode.Syntax` code, so consumers can match
 * `error.code === ErrorCode.Syntax` (or `hasErrorCode`) instead of the message.
 */
export class GqlSyntaxError extends LenkeError {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (at position ${pos})`, { code: ErrorCode.Syntax, details: { pos } });
    this.name = 'GqlSyntaxError';
    this.pos = pos;
  }
}
