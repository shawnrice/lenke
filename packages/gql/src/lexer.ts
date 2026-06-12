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

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
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
  const esc = src[i + 1]!;
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

export const tokenize = (src: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, value: string, pos: number, num?: number): void => {
    tokens.push({ type, value, pos, num });
  };

  while (i < src.length) {
    const c = src[i]!;

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
      push('ident', name, start);
      continue;
    }

    // Parameters: `$name`.
    if (c === '$') {
      const start = i;
      i += 1;
      const nameStart = i;
      while (i < src.length && isIdentPart(src[i]!)) {
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
      const isBasePrefix = c === '0' && 'xXoObB'.includes(src[i + 1] ?? '');
      if (isBasePrefix) {
        i += 2;
        while (i < src.length && /[0-9a-fA-F_]/.test(src[i]!)) {
          i += 1;
        }
      } else {
        const digits = (): void => {
          while (i < src.length && /[0-9_]/.test(src[i]!)) {
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
      push('number', text, start, Number(text.replace(/_/g, '')));
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) {
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

/** Thrown for both lex and parse errors, carrying the source offset. */
export class GqlSyntaxError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message} (at position ${pos})`);
    this.name = 'GqlSyntaxError';
    this.pos = pos;
  }
}
