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
  'insert',
  'set',
  'remove',
  'delete',
  'detach',
  'nodetach',
  'finish',
  'return',
  'as',
  'is',
  'in',
  'and',
  'or',
  'xor',
  'not',
  'distinct',
  'all',
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
    'abs acos all all_different and any array as asc ascending asin at atan avg big bigint ' +
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
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

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

// A hand-written scanner: one long switch over source characters. Splitting it
// would scatter the token rules and hurt readability more than the length costs.
// eslint-disable-next-line complexity, max-statements
export const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

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

    const two = src.slice(i, i + 2);

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
    if (src.slice(i, i + 3) === '<->') {
      push('lrarrow', '<->', i);
      i += 3;
      continue;
    }

    // Two-char operators.
    const twoChar: Record<string, TokenType> = {
      '->': 'rarrow',
      '<-': 'larrow',
      '<~': 'ltilde',
      '~>': 'tilder',
      '<>': 'neq',
      '<=': 'lte',
      '>=': 'gte',
      '||': 'concat',
    };
    const twoType = twoChar[two];

    if (twoType) {
      push(twoType, two, i);
      i += 2;
      continue;
    }

    // Single-char punctuation/operators.
    const single: Record<string, TokenType> = {
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
    // A `.` immediately followed by a digit is a leading-dot float (`.5`), not
    // the property-access dot — let it fall through to the number scanner below.
    const dotNumber = c === '.' && isDigit(src[i + 1] ?? '');
    const singleType = dotNumber ? undefined : single[c];

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
      let str = '';

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
    // never a keyword.
    if (c === '`') {
      const start = i;
      i += 1;
      let name = '';

      while (i < src.length && src[i] !== '`') {
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

      while (i < src.length && isIdentPart(src[i])) {
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
      // Track whether the literal is an *integer* form (no fraction/exponent).
      // Only integers are held to the safe-integer range; floats may exceed it
      // because they are inherently approximate.
      let isInteger = true;

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
          isInteger = false;
          i += 1;
          digits();
        }

        if (src[i] === 'e' || src[i] === 'E') {
          isInteger = false;
          i += 1;

          if (src[i] === '+' || src[i] === '-') {
            i += 1;
          }

          digits();
        }
      }

      const text = src.slice(start, i);
      const num = Number(text.replace(/_/g, ''));

      // A malformed mantissa/exponent (`1e`, `0x`, `.e5`) coerces to NaN; an
      // overflowing magnitude (`1e999`) to Infinity. Reject both — otherwise a
      // garbage `lit` node flows into the AST and downstream arithmetic.
      if (!Number.isFinite(num)) {
        throw new GqlSyntaxError(`Malformed numeric literal '${text}'`, start);
      }

      // An integer literal past 2^53 silently loses precision as a JS double.
      // Reject rather than return a value that differs from what was written.
      if (isInteger && !Number.isSafeInteger(num)) {
        throw new GqlSyntaxError(`Integer literal '${text}' exceeds the safe integer range`, start);
      }

      push('number', text, start, num);
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c)) {
      const start = i;

      while (i < src.length && isIdentPart(src[i])) {
        i += 1;
      }

      const text = src.slice(start, i);
      const lower = text.toLowerCase();

      if (KEYWORDS.has(lower)) {
        push('keyword', lower, start);
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
