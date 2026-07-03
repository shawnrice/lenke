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
export const prepare = (text: string): Plan => compile(parse(text));

/** Parse + run a query string against a graph in one call, with optional `$params`. */
export const query = (graph: Graph, text: string, params?: Record<string, unknown>): Row[] =>
  execute(parse(text), graph, params);

/**
 * Bind a graph and return a runner. Supports both a tagged-template form
 *   gql(g)`MATCH (a:Person) RETURN a.name`
 * and a plain-string form
 *   gql(g)('MATCH (a:Person) RETURN a.name')
 */
export const gql = (graph: Graph) => {
  const run = (text: string): Row[] => execute(parse(text), graph);

  return (strings: TemplateStringsArray | string, ...values: unknown[]): Row[] => {
    if (typeof strings === 'string') {
      return run(strings);
    }

    const text = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''),
      '',
    );

    return run(text);
  };
};

/** Parse a query string to its AST without executing (useful for tooling/tests). */
export const parseQuery = (text: string): Query => parse(text);
