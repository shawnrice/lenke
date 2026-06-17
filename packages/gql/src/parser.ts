/**
 * Recursive-descent parser: token stream -> `Query` AST.
 *
 * Grammar (informal). This is ISO GQL, not Cypher: `--` is a line comment,
 * undirected edges use `~`, and labels are boolean expressions, not `:A:B`.
 *
 *   query      = match where? return
 *   match      = MATCH pathPattern (',' pathPattern)*
 *   pathPattern= node (rel node)*
 *   node       = '(' var? (labelIntro labelExpr)? ')'
 *   rel        = abbrevEdge | '-'|'<-'|'~'|'<~' relDetail '-'|'->'|'~'|'~>'
 *   abbrevEdge = '->' | '<-' | '<->' | '~' | '~>'
 *   relDetail  = '[' var? (labelIntro labelExpr)? ']'
 *   labelIntro = ':' | IS
 *   labelExpr  = labelAnd ('|' labelAnd)*       // disjunction
 *   labelAnd   = labelNot ('&' labelNot)*       // conjunction
 *   labelNot   = '!' labelNot | labelPrimary    // negation
 *   labelPrimary = '%' | label | '(' labelExpr ')'
 *   where      = WHERE expr
 *   return     = RETURN DISTINCT? item (',' item)* (LIMIT number)?
 *   item       = expr (AS ident)?
 *   expr       = orExpr
 *   orExpr     = andExpr (OR andExpr)*
 *   andExpr    = notExpr (AND notExpr)*
 *   notExpr    = NOT notExpr | comparison
 *   comparison = primary (compareOp primary)?
 *   primary    = ident ('.' ident)? | literal | '(' expr ')'
 *   comment    = '//' line | '--' line | block comment
 */

import type {
  ArithOp,
  Clause,
  CompareOp,
  DeleteClause,
  Expr,
  InsertClause,
  LabelExpr,
  LinearQuery,
  MatchClause,
  NodePattern,
  PathPattern,
  Projection,
  PropertyConstraint,
  Query,
  RelPattern,
  RemoveClause,
  RemoveItem,
  SetOp,
  ReturnClause,
  ReturnItem,
  Segment,
  SetClause,
  SetItem,
  SortItem,
  WithClause,
} from './ast.js';
import { GqlSyntaxError, isReserved, type Token, type TokenType, tokenize } from './lexer.js';

/** Map the surrounding-arrow booleans to a relationship direction. */
const directionOf = (leftArrow: boolean, rightArrow: boolean): RelPattern['direction'] => {
  if (rightArrow && !leftArrow) {
    return 'out';
  }

  if (leftArrow && !rightArrow) {
    return 'in';
  }

  return 'both';
};

const COMPARE_OPS: Partial<Record<TokenType, CompareOp>> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  gt: '>',
  lte: '<=',
  gte: '>=',
};

const ADD_OPS: Partial<Record<TokenType, ArithOp>> = { plus: '+', dash: '-' };
const MUL_OPS: Partial<Record<TokenType, ArithOp>> = { star: '*', slash: '/', percent: '%' };

export const parse = (src: string): Query => {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token => tokens[pos];
  const atEnd = (): boolean => peek().type === 'eof';

  const advance = (): Token => tokens[pos++];

  const check = (type: TokenType): boolean => peek().type === type;

  const checkKeyword = (kw: string): boolean => peek().type === 'keyword' && peek().value === kw;

  const expect = (type: TokenType, what: string): Token => {
    if (!check(type)) {
      throw new GqlSyntaxError(
        `Expected ${what}, got '${peek().value || peek().type}'`,
        peek().pos,
      );
    }

    return advance();
  };

  const expectKeyword = (kw: string): Token => {
    if (!checkKeyword(kw)) {
      throw new GqlSyntaxError(
        `Expected '${kw.toUpperCase()}', got '${peek().value || peek().type}'`,
        peek().pos,
      );
    }

    return advance();
  };

  // Consume an identifier in a *binding* position (variable, label, property
  // key, alias). A bare reserved word is rejected per ISO; a delimited
  // identifier (backtick) may be any word.
  const bindName = (what: string): string => {
    const tok = expect('ident', what);

    if (!tok.delimited && isReserved(tok.value)) {
      throw new GqlSyntaxError(
        `'${tok.value}' is a reserved word; quote it as a delimited identifier`,
        tok.pos,
      );
    }

    return tok.value;
  };

  // --- patterns --------------------------------------------------------------

  // Pattern property map `{ k: expr, ... }` and inline `WHERE pred` — the ISO
  // element-pattern predicate, shared by node and edge patterns.
  const parsePropertyMap = (): PropertyConstraint[] => {
    expect('lbrace', "'{'");
    const props: PropertyConstraint[] = [];

    if (!check('rbrace')) {
      do {
        const key = bindName('a property name');
        expect('colon', "':'");
        props.push({ key, value: parseExpr() });
      } while (check('comma') && (advance(), true));
    }

    expect('rbrace', "'}'");

    return props;
  };

  const parsePredicate = (): { properties?: PropertyConstraint[]; where?: Expr } => {
    const properties = check('lbrace') ? parsePropertyMap() : undefined;
    const where = checkKeyword('where') ? (advance(), parseExpr()) : undefined;

    return { properties, where };
  };

  const parseNode = (): NodePattern => {
    expect('lparen', "'('");
    let variable: string | undefined;

    if (check('ident')) {
      variable = bindName('a variable');
    }

    // ISO label expression, introduced by `:` or `IS`.
    let label: LabelExpr | undefined;

    if (check('colon') || checkKeyword('is')) {
      advance();
      label = parseLabelExpr();
    }

    const { properties, where } = parsePredicate();
    expect('rparen', "')'");

    return { variable, label, properties, where };
  };

  // Label expressions, lowest-to-highest precedence: `|` < `&` < `!` < primary.
  const parseLabelExpr = (): LabelExpr => parseLabelOr();

  const parseLabelOr = (): LabelExpr => {
    let left = parseLabelAnd();

    while (check('pipe')) {
      advance();
      left = { kind: 'or', left, right: parseLabelAnd() };
    }

    return left;
  };

  const parseLabelAnd = (): LabelExpr => {
    let left = parseLabelNot();

    while (check('amp')) {
      advance();
      left = { kind: 'and', left, right: parseLabelNot() };
    }

    return left;
  };

  const parseLabelNot = (): LabelExpr => {
    if (check('bang')) {
      advance();

      return { kind: 'not', expr: parseLabelNot() };
    }

    return parseLabelPrimary();
  };

  const parseLabelPrimary = (): LabelExpr => {
    if (check('percent')) {
      advance();

      return { kind: 'wildcard' };
    }

    if (check('lparen')) {
      advance();
      const inner = parseLabelExpr();
      expect('rparen', "')' to close a label expression");

      return inner;
    }

    return { kind: 'label', name: bindName('a label name') };
  };

  const parseRelDetail = (): {
    variable?: string;
    label?: LabelExpr;
    properties?: PropertyConstraint[];
    where?: Expr;
  } => {
    // Caller has confirmed the next token is '['.
    expect('lbracket', "'['");
    let variable: string | undefined;

    if (check('ident')) {
      variable = bindName('a variable');
    }

    // ISO label expression over edge types, introduced by `:` or `IS`.
    let label: LabelExpr | undefined;

    if (check('colon') || checkKeyword('is')) {
      advance();
      label = parseLabelExpr();
    }

    const { properties, where } = parsePredicate();
    expect('rbracket', "']'");

    return { variable, label, properties, where };
  };

  // ISO abbreviated edges that stand alone (no bracket can follow them).
  const ABBREVIATED: Partial<Record<TokenType, RelPattern['direction']>> = {
    rarrow: 'out', // ->
    lrarrow: 'both', // <->
    tilder: 'both', // ~>
  };

  const parseRel = (): RelPattern => {
    // Pure abbreviated forms first.
    const abbrev = ABBREVIATED[peek().type];

    if (abbrev) {
      advance();

      return { direction: abbrev };
    }

    // Left marker: `<-` points in; `-`/`~`/`<~` are neutral so far. Each of
    // these can either stand alone (abbreviated) or open a bracketed edge.
    let leftArrow = false;

    if (check('larrow')) {
      advance();
      leftArrow = true;
    } else if (check('dash') || check('tilde') || check('ltilde')) {
      advance();
    } else {
      throw new GqlSyntaxError(
        `Expected a relationship (e.g. -[:T]->, <-[:T]-, ~[:T]~, ->), got '${peek().value || peek().type}'`,
        peek().pos,
      );
    }

    // No bracket → abbreviated edge: `<-` is incoming, the rest are undirected.
    if (!check('lbracket')) {
      return { direction: leftArrow ? 'in' : 'both' };
    }

    const detail = parseRelDetail();

    // Closing marker: `->` points out; `-`/`~`/`~>` are neutral.
    let rightArrow = false;

    if (check('rarrow')) {
      advance();
      rightArrow = true;
    } else if (check('dash') || check('tilde') || check('tilder')) {
      advance();
    } else {
      throw new GqlSyntaxError(
        `Expected ']->', ']-' or ']~' to close a relationship, got '${peek().value || peek().type}'`,
        peek().pos,
      );
    }

    return {
      variable: detail.variable,
      label: detail.label,
      direction: directionOf(leftArrow, rightArrow),
      properties: detail.properties,
      where: detail.where,
    };
  };

  const startsRelationship = (): boolean =>
    check('dash') ||
    check('larrow') ||
    check('rarrow') ||
    check('lrarrow') ||
    check('tilde') ||
    check('ltilde') ||
    check('tilder');

  // Variable-length quantifier following an edge: `*`, `+`, `{n}`, `{n,m}`,
  // `{n,}`, `{,m}`.
  const parseQuantifier = (): RelPattern['quantifier'] => {
    if (check('star')) {
      advance();

      return { min: 0, max: null };
    }

    if (check('plus')) {
      advance();

      return { min: 1, max: null };
    }

    if (check('lbrace')) {
      advance();
      const min = check('number') ? advance().num! : 0;
      let max: number | null = min;

      if (check('comma')) {
        advance();
        max = check('number') ? advance().num! : null;
      }

      expect('rbrace', "'}' to close a quantifier");

      return { min, max };
    }

    return undefined;
  };

  const parsePathPattern = (): PathPattern => {
    const start = parseNode();
    const segments: Segment[] = [];

    while (startsRelationship()) {
      const rel = parseRel();
      const quantifier = parseQuantifier();
      const node = parseNode();
      segments.push({ rel: quantifier ? { ...rel, quantifier } : rel, node });
    }

    return { start, segments };
  };

  const parseMatchClause = (): MatchClause => {
    const optional = checkKeyword('optional') ? (advance(), true) : false;
    expectKeyword('match');
    const patterns: PathPattern[] = [parsePathPattern()];

    while (check('comma')) {
      advance();
      patterns.push(parsePathPattern());
    }

    const where = checkKeyword('where') ? (advance(), parseExpr()) : undefined;

    return { kind: 'match', optional, patterns, where };
  };

  // --- expressions -----------------------------------------------------------

  // Precedence, loosest to tightest (ISO §24): OR/XOR, AND, NOT, IS/IN
  // predicates, comparison, `||`, +/-, *///%, unary, primary.
  const parseExpr = (): Expr => parseOrXor();

  // ISO/IEC 39075 `<boolean value expression>`: OR and XOR share one (loosest)
  // precedence level and are left-associative, so `a OR b XOR c` parses as
  // `(a OR b) XOR c`. AND (`<boolean term>`) binds tighter, NOT tighter still.
  // NB: a deliberate divergence from Cypher, which gives XOR higher precedence
  // than OR — we follow the ISO grammar, not Cypher.
  const parseOrXor = (): Expr => {
    let left = parseAnd();

    while (checkKeyword('or') || checkKeyword('xor')) {
      const kind = advance().value === 'or' ? 'or' : 'xor';
      left = { kind, left, right: parseAnd() };
    }

    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseNot();

    while (checkKeyword('and')) {
      advance();
      left = { kind: 'and', left, right: parseNot() };
    }

    return left;
  };

  const parseNot = (): Expr => {
    if (checkKeyword('not')) {
      advance();

      return { kind: 'not', expr: parseNot() };
    }

    return parsePostfixPredicate();
  };

  // Postfix predicates: `x IS [NOT] NULL`, `x IS [NOT] TRUE|FALSE|UNKNOWN`,
  // `x [NOT] IN list`.
  const parsePostfixPredicate = (): Expr => {
    const e = parseComparison();

    if (checkKeyword('is')) {
      advance();
      const negated = checkKeyword('not') ? (advance(), true) : false;

      if (checkKeyword('null')) {
        advance();

        return { kind: 'isNull', expr: e, negated };
      }

      // ISO `<boolean test>`: IS [NOT] TRUE | FALSE | UNKNOWN.
      if (checkKeyword('true')) {
        advance();

        return { kind: 'isTruth', expr: e, truth: true, negated };
      }

      if (checkKeyword('false')) {
        advance();

        return { kind: 'isTruth', expr: e, truth: false, negated };
      }

      if (checkKeyword('unknown')) {
        advance();

        return { kind: 'isTruth', expr: e, truth: null, negated };
      }

      // ISO `<labeled predicate>`: IS [NOT] LABELED <label expression>. LABELED
      // is a non-reserved keyword, so it arrives as an identifier.
      if (check('ident') && peek().value.toLowerCase() === 'labeled') {
        advance();

        return { kind: 'isLabeled', expr: e, label: parseLabelExpr(), negated };
      }

      throw new GqlSyntaxError(
        'Expected NULL, TRUE, FALSE, UNKNOWN, or LABELED after IS',
        peek().pos,
      );
    }

    if (checkKeyword('in')) {
      advance();

      return { kind: 'in', expr: e, list: parseUnary(), negated: false };
    }

    if (checkKeyword('not')) {
      advance();
      expectKeyword('in');

      return { kind: 'in', expr: e, list: parseUnary(), negated: true };
    }

    return e;
  };

  const parseComparison = (): Expr => {
    const left = parseConcat();
    const op = COMPARE_OPS[peek().type];

    if (op) {
      advance();

      return { kind: 'compare', op, left, right: parseConcat() };
    }

    return left;
  };

  const parseConcat = (): Expr => {
    let left = parseAdditive();

    while (check('concat')) {
      advance();
      left = { kind: 'concat', left, right: parseAdditive() };
    }

    return left;
  };

  const parseAdditive = (): Expr => {
    let left = parseMultiplicative();
    let op = ADD_OPS[peek().type];

    while (op) {
      advance();
      left = { kind: 'arith', op, left, right: parseMultiplicative() };
      op = ADD_OPS[peek().type];
    }

    return left;
  };

  const parseMultiplicative = (): Expr => {
    let left = parseUnary();
    let op = MUL_OPS[peek().type];

    while (op) {
      advance();
      left = { kind: 'arith', op, left, right: parseUnary() };
      op = MUL_OPS[peek().type];
    }

    return left;
  };

  const parseUnary = (): Expr => {
    if (check('dash')) {
      advance();

      return { kind: 'neg', expr: parseUnary() };
    }

    if (check('plus')) {
      advance();

      return parseUnary();
    }

    return parsePrimary();
  };

  // The body shared by the braced subqueries `EXISTS { … }` and `COUNT { … }`:
  // `{ pattern, … [WHERE pred] }`, with an optional leading MATCH keyword.
  const parseBracedSubquery = (): { patterns: PathPattern[]; where?: Expr } => {
    expect('lbrace', "'{'");

    if (checkKeyword('match')) {
      advance();
    }

    const patterns: PathPattern[] = [parsePathPattern()];

    while (check('comma')) {
      advance();
      patterns.push(parsePathPattern());
    }

    const where = checkKeyword('where') ? (advance(), parseExpr()) : undefined;
    expect('rbrace', "'}'");

    return { patterns, where };
  };

  // `(*)` | `(DISTINCT? expr, …)` — the argument list of a function/aggregate
  // call, the caller having already consumed the function name.
  const parseCallArgs = (): { args: Expr[]; distinct: boolean; star: boolean } => {
    expect('lparen', "'(' to open a function call");
    let star = false;
    let distinct = false;
    const args: Expr[] = [];

    if (check('star')) {
      advance();
      star = true;
    } else if (!check('rparen')) {
      if (checkKeyword('distinct')) {
        advance();
        distinct = true;
      }

      args.push(parseExpr());

      while (check('comma')) {
        advance();
        args.push(parseExpr());
      }
    }

    expect('rparen', "')' to close a function call");

    return { args, distinct, star };
  };

  // EXISTS is a reserved word; it only introduces a braced subquery.
  const parseExists = (): Expr => {
    expectKeyword('exists');

    return { kind: 'exists', ...parseBracedSubquery() };
  };

  // COUNT is reserved and overloaded: `COUNT { … }` is the subquery, `COUNT(…)`
  // (incl. `COUNT(*)`) is the aggregate.
  const parseCount = (): Expr => {
    expectKeyword('count');

    if (check('lbrace')) {
      return { kind: 'countSubquery', ...parseBracedSubquery() };
    }

    return { kind: 'func', name: 'count', ...parseCallArgs() };
  };

  // ISO `<case expression>`: `CASE [subject] (WHEN test THEN result)+ [ELSE r] END`.
  // A subject before the first WHEN makes it a simple CASE; otherwise searched.
  const parseCase = (): Expr => {
    expectKeyword('case');
    const subject = checkKeyword('when') ? undefined : parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];

    while (checkKeyword('when')) {
      advance();
      const when = parseExpr();
      expectKeyword('then');
      // `then` is the ISO GQL CASE…WHEN…THEN branch, not a thenable; never awaited.
      // eslint-disable-next-line unicorn/no-thenable
      whens.push({ when, then: parseExpr() });
    }

    if (whens.length === 0) {
      throw new GqlSyntaxError('CASE requires at least one WHEN ... THEN', peek().pos);
    }

    const elseExpr = checkKeyword('else') ? (advance(), parseExpr()) : undefined;
    expectKeyword('end');

    return { kind: 'case', subject, whens, elseExpr };
  };

  const parsePrimary = (): Expr => {
    const t = peek();

    if (t.type === 'number') {
      advance();

      return { kind: 'lit', value: t.num };
    }

    if (t.type === 'string') {
      advance();

      return { kind: 'lit', value: t.value };
    }

    if (t.type === 'param') {
      advance();

      return { kind: 'param', name: t.value };
    }

    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      advance();

      return { kind: 'lit', value: t.value === 'true' };
    }

    if (t.type === 'keyword' && t.value === 'null') {
      advance();

      return { kind: 'lit', value: null };
    }

    if (checkKeyword('case')) {
      return parseCase();
    }

    if (checkKeyword('exists')) {
      return parseExists();
    }

    if (checkKeyword('count')) {
      return parseCount();
    }

    if (t.type === 'lparen') {
      advance();
      const inner = parseExpr();
      expect('rparen', "')'");

      return inner;
    }

    if (t.type === 'lbracket') {
      advance();
      const items: Expr[] = [];

      if (!check('rbracket')) {
        do {
          items.push(parseExpr());
        } while (check('comma') && (advance(), true));
      }

      expect('rbracket', "']' to close a list");

      return { kind: 'list', items };
    }

    if (t.type === 'ident') {
      advance();

      // Function call: the name may be a reserved word (e.g. UPPER, SUM, ABS).
      if (check('lparen')) {
        return { kind: 'func', name: t.value.toLowerCase(), ...parseCallArgs() };
      }

      // A bare reserved word is not a valid variable reference.
      if (!t.delimited && isReserved(t.value)) {
        throw new GqlSyntaxError(
          `'${t.value}' is a reserved word; quote it as a delimited identifier`,
          t.pos,
        );
      }

      if (check('dot')) {
        advance();
        const key = bindName('a property name');

        return { kind: 'prop', variable: t.value, key };
      }

      return { kind: 'var', name: t.value };
    }

    throw new GqlSyntaxError(`Unexpected '${t.value || t.type}' in expression`, t.pos);
  };

  // --- return ----------------------------------------------------------------

  const parseReturnItem = (): ReturnItem => {
    const expr = parseExpr();
    let alias: string | undefined;

    if (checkKeyword('as')) {
      advance();
      alias = bindName('an alias name');
    }

    return { expr, alias };
  };

  const parseSortItem = (): SortItem => {
    const expr = parseExpr();
    let descending = false;

    if (checkKeyword('desc') || checkKeyword('descending')) {
      advance();
      descending = true;
    } else if (checkKeyword('asc') || checkKeyword('ascending')) {
      advance();
    }

    // ISO `<null ordering>`: optional NULLS FIRST | NULLS LAST. NULLS is a
    // reserved word; FIRST/LAST are non-reserved, so they arrive as identifiers.
    let nullsFirst: boolean | undefined;

    if (checkKeyword('nulls')) {
      advance();
      const where = check('ident') ? peek().value.toLowerCase() : '';

      if (where === 'first') {
        nullsFirst = true;
        advance();
      } else if (where === 'last') {
        nullsFirst = false;
        advance();
      } else {
        throw new GqlSyntaxError('Expected FIRST or LAST after NULLS', peek().pos);
      }
    }

    return { expr, descending, nullsFirst };
  };

  // The shared projection body of WITH and RETURN.
  const parseProjection = (): Projection => {
    const distinct = checkKeyword('distinct') ? (advance(), true) : false;

    let star = false;
    const items: ReturnItem[] = [];

    if (check('star')) {
      advance();
      star = true;
    } else {
      items.push(parseReturnItem());

      while (check('comma')) {
        advance();
        items.push(parseReturnItem());
      }
    }

    let orderBy: SortItem[] | undefined;

    if (checkKeyword('order')) {
      advance();
      expectKeyword('by');
      orderBy = [parseSortItem()];

      while (check('comma')) {
        advance();
        orderBy.push(parseSortItem());
      }
    }

    let skip: number | undefined;

    if (checkKeyword('skip') || checkKeyword('offset')) {
      advance();
      skip = expect('number', 'a number after SKIP/OFFSET').num;
    }

    let limit: number | undefined;

    if (checkKeyword('limit')) {
      advance();
      limit = expect('number', 'a number after LIMIT').num;
    }

    return { star, items, distinct, orderBy, skip, limit };
  };

  const parseWithClause = (): WithClause => {
    expectKeyword('with');
    const projection = parseProjection();
    const where = checkKeyword('where') ? (advance(), parseExpr()) : undefined;

    return { kind: 'with', projection, where };
  };

  const parseReturnClause = (): ReturnClause => {
    expectKeyword('return');

    return { kind: 'return', projection: parseProjection() };
  };

  // --- write clauses ---------------------------------------------------------

  const parseInsertClause = (): InsertClause => {
    expectKeyword('insert');
    const patterns: PathPattern[] = [parsePathPattern()];

    while (check('comma')) {
      advance();
      patterns.push(parsePathPattern());
    }

    return { kind: 'insert', patterns };
  };

  const parseSetItem = (): SetItem => {
    const variable = bindName('a variable');

    if (check('colon') || checkKeyword('is')) {
      advance();

      return { variable, label: bindName('a label name') };
    }

    expect('dot', "'.' or ':'");
    const key = bindName('a property name');
    expect('eq', "'='");

    return { variable, key, value: parseExpr() };
  };

  const parseSetClause = (): SetClause => {
    expectKeyword('set');
    const items: SetItem[] = [parseSetItem()];

    while (check('comma')) {
      advance();
      items.push(parseSetItem());
    }

    return { kind: 'set', items };
  };

  const parseRemoveItem = (): RemoveItem => {
    const variable = bindName('a variable');

    if (check('colon') || checkKeyword('is')) {
      advance();

      return { variable, label: bindName('a label name') };
    }

    expect('dot', "'.' or ':'");

    return { variable, key: bindName('a property name') };
  };

  const parseRemoveClause = (): RemoveClause => {
    expectKeyword('remove');
    const items: RemoveItem[] = [parseRemoveItem()];

    while (check('comma')) {
      advance();
      items.push(parseRemoveItem());
    }

    return { kind: 'remove', items };
  };

  const parseDeleteClause = (): DeleteClause => {
    const detach = checkKeyword('detach') ? (advance(), true) : false;

    if (!detach && checkKeyword('nodetach')) {
      advance();
    }

    expectKeyword('delete');
    const targets: Expr[] = [parseExpr()];

    while (check('comma')) {
      advance();
      targets.push(parseExpr());
    }

    return { kind: 'delete', detach, targets };
  };

  // A linear query: a sequence of clauses, optionally ending in RETURN or
  // FINISH (a write-only query needs neither).
  const parseLinearQuery = (): LinearQuery => {
    const clauses: Clause[] = [];
    let done = false;

    while (!done && !atEnd()) {
      if (checkKeyword('return')) {
        clauses.push(parseReturnClause());
        done = true;
      } else if (checkKeyword('finish')) {
        advance();
        clauses.push({ kind: 'finish' });
        done = true;
      } else if (checkKeyword('with')) {
        clauses.push(parseWithClause());
      } else if (checkKeyword('match') || checkKeyword('optional')) {
        clauses.push(parseMatchClause());
      } else if (checkKeyword('insert')) {
        clauses.push(parseInsertClause());
      } else if (checkKeyword('set')) {
        clauses.push(parseSetClause());
      } else if (checkKeyword('remove')) {
        clauses.push(parseRemoveClause());
      } else if (checkKeyword('delete') || checkKeyword('detach') || checkKeyword('nodetach')) {
        clauses.push(parseDeleteClause());
      } else {
        break;
      }
    }

    if (clauses.length === 0) {
      throw new GqlSyntaxError(
        `Expected a clause (MATCH, INSERT, RETURN, …), got '${peek().value || peek().type}'`,
        peek().pos,
      );
    }

    return { clauses };
  };

  // --- top level: linear queries joined by set operators ---------------------

  const SET_OPS: Partial<Record<string, SetOp['op']>> = {
    union: 'union',
    except: 'except',
    intersect: 'intersect',
  };

  const parts: LinearQuery[] = [parseLinearQuery()];
  const ops: SetOp[] = [];

  while (peek().type === 'keyword' && SET_OPS[peek().value]) {
    const op = SET_OPS[advance().value]!;
    const all = checkKeyword('all') ? (advance(), true) : false;

    if (!all && checkKeyword('distinct')) {
      advance();
    }

    ops.push({ op, all });
    parts.push(parseLinearQuery());
  }

  if (!atEnd()) {
    throw new GqlSyntaxError(
      `Unexpected trailing input '${peek().value || peek().type}'`,
      peek().pos,
    );
  }

  return { parts, ops };
};
