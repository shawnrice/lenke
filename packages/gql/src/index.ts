import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Statement } from './ast.js';
import { isTxControl } from './ast.js';
import {
  compile,
  compileValidator,
  execute,
  freePredicateVars,
  type Plan,
  type Row,
} from './executor.js';
import { parse, parsePredicate } from './parser.js';

export type {
  Query,
  Statement,
  TxControl,
  MatchClause,
  PathPattern,
  NodePattern,
  RelPattern,
  Expr,
} from './ast.js';
export { isTxControl } from './ast.js';
export type { Plan, Row } from './executor.js';
export { GqlSyntaxError, isReserved, quoteIdent } from './lexer.js';
export { parse, parsePredicate } from './parser.js';
export { compile, compileValidator, execute } from './executor.js';

/**
 * Declare a custom VALIDATOR constraint: every element carrying `label` (a vertex
 * label OR an edge type) must satisfy the GQL boolean `predicate`, with the
 * element bound to `varName` (`createValidator(g, 'User', 'u', 'u.age >= 0 AND
 * u.age < 150')`). `predicate` is pure ISO GQL — exactly what can follow `WHERE`.
 *
 * SQL-`CHECK` semantics: a write is rejected ({@link ErrorCode.ConstraintViolation})
 * only when the predicate evaluates to a *definite* `false`; a `null`/unknown
 * result PASSES (an element with an absent optional property isn't a violation).
 * Enforced at the mutation boundary and deferred to a transaction/statement
 * commit like the other constraints. A declare-time scan rejects if any existing
 * element already fails. An unparseable `predicate` throws {@link GqlSyntaxError}
 * (`E_SYNTAX`) here, at declaration time.
 *
 * Only `@lenke/gql` can offer this (core can't parse a GQL expression): the
 * predicate is parsed+compiled into a closure and registered into the graph via
 * `graph.registerValidator`. The native engine's `RustGraph.createValidator`
 * takes the SAME `(label, varName, predicate)` and enforces it identically in the
 * Rust GQL evaluator — the byte-identical dual-engine invariant.
 */
export const createValidator = (
  graph: Graph,
  label: string,
  varName: string,
  predicate: string,
): void => {
  // A native `RustGraph` compiles + enforces the predicate in-engine (no JS
  // closure), exposing `createValidator` as a *method*. Dispatch to it so this
  // free-function form works on either engine instead of throwing a raw
  // `TypeError` ("registerValidator is not a function") on a native graph.
  const nat = graph as unknown as {
    registerValidator?: unknown;
    createValidator?: (l: string, v: string, p: string) => void;
  };

  if (typeof nat.registerValidator !== 'function') {
    if (typeof nat.createValidator === 'function') {
      nat.createValidator(label, varName, predicate);

      return;
    }

    throw new LenkeError('createValidator: expected a @lenke/core Graph or a native RustGraph', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const expr = parsePredicate(predicate);

  // Reject a predicate that references any variable *other* than the declared
  // `varName` at DECLARE time. Such a name (`x.age` when the binding is `u`, or a
  // bare `age`) is unbound → the predicate reads UNKNOWN → the SQL-`CHECK` never
  // fires and the validator silently does nothing. A predicate with no variable
  // at all (a constant like `1 = 1`) is legitimately allowed. Uses `E_SYNTAX`,
  // matching the native engine (whose FFI already maps a bad predicate to that
  // code) so both engines reject identically.
  for (const name of freePredicateVars(expr)) {
    if (name !== varName) {
      throw new LenkeError(
        `validator predicate references unbound variable \`${name}\` (only the declared variable \`${varName}\` is in scope)`,
        { code: ErrorCode.Syntax },
      );
    }
  }

  const compiled = compileValidator(expr, varName);

  graph.registerValidator(label, varName, predicate, (element) => compiled(element, graph));
};

/**
 * Declare a graph-level INVARIANT: a whole-graph GQL assertion `query` (a full
 * `MATCH … RETURN`, not a bare predicate) that must hold after every write
 * transaction — the cross-write analogue of a per-element {@link createValidator}
 * (`createInvariant(g, 'balanced', 'MATCH (a:Acct) RETURN sum(a.balance) = 0')`).
 *
 * Unlike a validator (checked per touched element), an invariant is evaluated
 * ONCE per commit against the fully-staged graph. `false`-only-fails: the
 * invariant is VIOLATED iff any cell in the result set is boolean `false`;
 * everything else — `true`, `null`, a non-boolean value, an empty result set —
 * HOLDS. So `RETURN sum(a.balance) = 0` fails only when the sum isn't zero.
 * Violations throw {@link ErrorCode.ConstraintViolation} and roll the transaction
 * back. It runs at every commit boundary (each auto-committing GQL write
 * statement, and `graph.transaction(fn)`), but only when the transaction actually
 * wrote something — a pure-read transaction never pays the cost. A declare-time
 * run rejects (`ConstraintViolation`) if the current graph already violates it.
 * An unparseable/uncompilable `query` throws {@link GqlSyntaxError} (`E_SYNTAX`)
 * here, at declaration time.
 *
 * Only `@lenke/gql` can offer this (core can't parse a GQL query): the query is
 * parsed+compiled into a closure and registered into the graph via
 * `graph.registerInvariant`. The native engine's `RustGraph.createInvariant`
 * takes the SAME `(name, query)` and enforces it identically in the Rust GQL
 * evaluator — the byte-identical dual-engine invariant.
 */
export const createInvariant = (graph: Graph, name: string, querySrc: string): void => {
  // Native `RustGraph` exposes `createInvariant` as a *method* (enforced
  // in-engine); dispatch to it so this free-function form works on either engine.
  const nat = graph as unknown as {
    registerInvariant?: unknown;
    createInvariant?: (n: string, q: string) => void;
  };

  if (typeof nat.registerInvariant !== 'function') {
    if (typeof nat.createInvariant === 'function') {
      nat.createInvariant(name, querySrc);

      return;
    }

    throw new LenkeError('createInvariant: expected a @lenke/core Graph or a native RustGraph', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const parsed = parse(querySrc);

  // An invariant must be a whole-graph `MATCH … RETURN` assertion, never a
  // transaction-control command.
  if (isTxControl(parsed)) {
    throw new LenkeError('an invariant must be a MATCH … RETURN query, not a transaction command', {
      code: ErrorCode.Unsupported,
    });
  }

  const plan = compile(parsed);

  graph.registerInvariant(name, querySrc, (g) => plan(g));
};

/**
 * Parse + compile a query string into a reusable `Plan`. Do this once for a hot
 * query, then call the plan with just `(graph, params)` — no re-parse, no
 * re-analysis per run.
 */
export const prepare = <R extends Row = Row>(
  text: string,
  opts?: { maxOperatorChain?: number },
): Plan<R> => {
  const parsed = parse(text, { maxOperatorChain: opts?.maxOperatorChain });

  // A transaction-control command has no reusable plan — run it with `query()`.
  if (isTxControl(parsed)) {
    throw new LenkeError(
      'cannot prepare a transaction-control statement (START TRANSACTION/COMMIT/ROLLBACK); run it with query()',
      { code: ErrorCode.Unsupported },
    );
  }

  return compile<R>(parsed);
};

/**
 * Fold a graph's wired {@link Clock} (`graph.setClock`) into a query's params:
 * bind `$__now` from the clock for the ISO now-functions, unless the caller
 * passed an explicit `$__now` (explicit always wins — deterministic for tests).
 * Returns the params unchanged when no clock is wired — zero cost on the common
 * path. The engine never reads a clock; this resolves one host-side per query.
 */
const withClock = (
  graph: Graph,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const { clock } = graph;

  if (!clock || (params && Object.hasOwn(params, '__now'))) {
    return params;
  }

  return { ...params, __now: clock() };
};

/**
 * Parse + run a query string against a graph in one call, with optional
 * `$params`. Pass a row shape to type the result — `query<{ name: string }>(g,
 * '… RETURN a.name AS name')` returns `{ name: string }[]` — an opt-in,
 * caller-side assertion (rows are `Record<string, unknown>` at runtime).
 *
 * `graph.setClock(() => …)` makes `current_date`/`current_timestamp` read wall
 * time; an explicit `params.__now` overrides that clock.
 */
export const query = <R extends Row = Row>(
  graph: Graph,
  text: string,
  params?: Record<string, unknown>,
): R[] =>
  execute<R>(
    parse(text, { maxOperatorChain: graph.maxOperatorChain }),
    graph,
    withClock(graph, params),
  );

/**
 * Bind a graph and return a runner. Supports both a tagged-template form
 *   gql(g)`MATCH (a:Person) WHERE a.name = ${name} RETURN a`
 * and a plain-string form (with optional `$name` bindings)
 *   gql(g)('MATCH (a:Person) WHERE a.name = $name RETURN a', { name })
 *
 * Template `${}` substitutions compile to `$p0…$pn` **bindings** — values bind
 * to already-parsed param slots at execute time and never touch the parser, so
 * quotes/operators/keywords in a value stay inert data. (They are NOT spliced
 * into the query text.) Templates own the `$p<n>` namespace — don't hand-write
 * `$p0` inside a template that also has `${}` substitutions. This is the same
 * convention as `@lenke/native`'s `RustGraph.query`, so consumers feel no seam
 * between engines.
 */
export const gql = <R extends Row = Row>(graph: Graph) => {
  return (strings: TemplateStringsArray | string, ...values: unknown[]): R[] => {
    if (typeof strings === 'string') {
      const params = values[0] as Record<string, unknown> | undefined;

      return execute<R>(
        parse(strings, { maxOperatorChain: graph.maxOperatorChain }),
        graph,
        withClock(graph, params),
      );
    }

    const params: Record<string, unknown> = {};
    const text = strings.reduce((acc, part, i) => {
      if (i >= values.length) {
        return acc + part;
      }

      params[`p${i}`] = values[i];

      return `${acc + part}$p${i}`;
    }, '');

    return execute<R>(
      parse(text, { maxOperatorChain: graph.maxOperatorChain }),
      graph,
      withClock(graph, params),
    );
  };
};

/**
 * Parse a query string to its AST without executing (useful for tooling/tests).
 * Returns a {@link Statement}: a {@link Query}, or a {@link TxControl} for a
 * `START TRANSACTION`/`COMMIT`/`ROLLBACK` command.
 */
export const parseQuery = (text: string): Statement => parse(text);
