import type { Graph } from '@lenke/core';

import type { Query } from './ast.js';
import { compile, execute, type Plan, type Row } from './executor.js';
import { parse } from './parser.js';

export type { Query, MatchClause, PathPattern, NodePattern, RelPattern, Expr } from './ast.js';
export type { Plan, Row } from './executor.js';
export { GqlSyntaxError } from './lexer.js';
export { parse } from './parser.js';
export { compile, execute } from './executor.js';

/**
 * Parse + compile a query string into a reusable `Plan`. Do this once for a hot
 * query, then call the plan with just `(graph, params)` — no re-parse, no
 * re-analysis per run.
 */
export const prepare = <R extends Row = Row>(text: string): Plan<R> => compile<R>(parse(text));

/**
 * Parse + run a query string against a graph in one call, with optional
 * `$params`. Pass a row shape to type the result — `query<{ name: string }>(g,
 * '… RETURN a.name AS name')` returns `{ name: string }[]` — an opt-in,
 * caller-side assertion (rows are `Record<string, unknown>` at runtime).
 */
export const query = <R extends Row = Row>(
  graph: Graph,
  text: string,
  params?: Record<string, unknown>,
): R[] => execute<R>(parse(text), graph, params);

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
      return execute<R>(parse(strings), graph, values[0] as Record<string, unknown> | undefined);
    }

    const params: Record<string, unknown> = {};
    const text = strings.reduce((acc, part, i) => {
      if (i >= values.length) {
        return acc + part;
      }

      params[`p${i}`] = values[i];

      return `${acc + part}$p${i}`;
    }, '');

    return execute<R>(parse(text), graph, params);
  };
};

/** Parse a query string to its AST without executing (useful for tooling/tests). */
export const parseQuery = (text: string): Query => parse(text);
