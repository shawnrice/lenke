import type { Graph } from '@pl-graph/core';

import type { Query } from './ast.js';
import { execute, type Row } from './executor.js';
import { parse } from './parser.js';

export type { Query, MatchClause, PathPattern, NodePattern, RelPattern, Expr } from './ast.js';
export type { Row } from './executor.js';
export { GqlSyntaxError } from './lexer.js';
export { parse } from './parser.js';
export { execute } from './executor.js';

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
