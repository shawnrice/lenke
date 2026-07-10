import type { Clause, PathPattern, Projection, Query } from './ast.js';
import { parse } from './parser.js';

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'collect_list']);

// Does any node in this subtree invoke an aggregate function? (Walks the AST
// generically, so it doesn't need to know every expression shape.)
const containsAggregate = (node: unknown): boolean => {
  if (node === null || typeof node !== 'object') {
    return false;
  }

  const { kind, name } = node as { kind?: unknown; name?: unknown };

  if (kind === 'func' && typeof name === 'string' && AGGREGATES.has(name)) {
    return true;
  }

  return Object.values(node).some(containsAggregate);
};

// A path `(a)-[:R]->(b)` is 1 node + 2 elements per segment.
const elementCount = (pattern: PathPattern): number => 1 + pattern.segments.length * 2;

const projection = (p: Projection): string => {
  const parts = [`${p.items.length} item${p.items.length === 1 ? '' : 's'}`];

  if (p.distinct) {
    parts.push('distinct');
  }

  if (p.items.some((item) => containsAggregate(item))) {
    parts.push('aggregating');
  }

  if (p.orderBy?.length) {
    parts.push(`order by ${p.orderBy.length}`);
  }

  if (p.skip !== undefined) {
    parts.push(`skip ${p.skip}`);
  }

  if (p.limit !== undefined) {
    parts.push(`limit ${p.limit}`);
  }

  return parts.join(', ');
};

const clauseLine = (clause: Clause): string => {
  switch (clause.kind) {
    case 'match': {
      const elements = clause.patterns.reduce((n, pattern) => n + elementCount(pattern), 0);

      return `MATCH${clause.optional ? ' (optional)' : ''} — ${clause.patterns.length} pattern(s), ${elements} elements${clause.where ? ', WHERE' : ''}`;
    }
    case 'with':
      return `WITH — ${projection(clause.projection)}${clause.where ? ', WHERE' : ''}`;
    case 'return':
      return `RETURN — ${projection(clause.projection)}`;
    case 'insert':
      return `INSERT — ${clause.patterns.length} pattern(s)`;
    case 'set':
      return `SET — ${clause.items.length} assignment(s)`;
    case 'remove':
      return `REMOVE — ${clause.items.length} item(s)`;
    case 'delete':
      return `DELETE${clause.detach ? ' (detach)' : ''} — ${clause.targets.length} target(s)`;
    case 'finish':
      return 'FINISH';
    default:
      return (clause as { kind: string }).kind;
  }
};

/**
 * Render a query's logical structure: its parsed clause sequence (each clause
 * summarized) and any set operations between linear parts.
 *
 * Note: lenke lowers a GQL query into a tree of closures (`compile()`), not an
 * inspectable structure, and has no cost-based optimizer — so this is the
 * *logical* plan (what the parser understood), which is the plan's shape. A
 * physical, index-aware EXPLAIN would need the compiler instrumented.
 */
export const explain = (query: string | Query): string => {
  const parsed = typeof query === 'string' ? parse(query) : query;
  const out = [`Query — ${parsed.parts.length} part${parsed.parts.length === 1 ? '' : 's'}`];

  parsed.parts.forEach((part, i) => {
    const op = i > 0 ? parsed.ops[i - 1] : undefined;

    if (op) {
      out.push(`  ${op.op.toUpperCase()}${op.all ? ' ALL' : ''}`);
    }

    for (const clause of part.clauses) {
      out.push(`  ${clauseLine(clause)}`);
    }
  });

  return out.join('\n');
};
