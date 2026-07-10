import type { Graph } from '@lenke/core';

import type { Clause, MatchClause, PathPattern, Projection, Query } from './ast.js';
import { type PatternPlan, planMatch } from './executor.js';
import { parse } from './parser.js';

type Params = Record<string, unknown>;

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

// The logical, graph-independent one-liner for a clause (used with no graph, and
// for the non-MATCH clauses even when a graph is given).
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

const expandArrow = (direction: 'out' | 'in' | 'both', rel: string): string => {
  if (direction === 'out') {
    return `-[${rel}]->`;
  }

  if (direction === 'in') {
    return `<-[${rel}]-`;
  }

  return `~[${rel}]~`;
};

const seedLine = (seed: PatternPlan['seed']): string => {
  const anchor = seed.variable ?? (seed.label ? `:${seed.label}` : 'node');
  const detail =
    seed.detail ?? (seed.label && seed.strategy !== 'index seek' ? `:${seed.label}` : '');
  const suffix = detail ? ` ${detail}` : '';

  return `seed ${anchor} → ${seed.strategy}${suffix}  (~${seed.estimated} vertices)`;
};

// The physical plan lines for a MATCH clause, run against a real graph.
const matchPlan = (graph: Graph, clause: MatchClause, params: Params): string[] => {
  const out = [`MATCH${clause.optional ? ' (optional)' : ''}`];

  for (const pattern of planMatch(graph, clause, params)) {
    out.push(`  ${seedLine(pattern.seed)}`);

    for (const step of pattern.expansions) {
      const rel = step.relLabels.length > 0 ? `:${step.relLabels.join('|')}` : '';
      const node = step.node.variable ?? (step.node.label ? `:${step.node.label}` : '');

      out.push(`    expand ${expandArrow(step.direction, rel)} (${node})`);
    }
  }

  if (clause.where) {
    out.push('  filter: WHERE (residual)');
  }

  return out;
};

/**
 * Render a query's plan.
 *
 * With a `graph`, each MATCH shows the **physical** plan the executor will run
 * against it — which end each pattern seeds from, the seed strategy (index seek
 * / label scan / full scan) with a cardinality estimate, and the expansion. This
 * is the real planner's decision, so it answers "did my index get used?".
 *
 * Without a graph it's the **logical** view — the parsed clause structure — which
 * is all that can be known without index sizes.
 */
export const explain = (query: string | Query, graph?: Graph, params: Params = {}): string => {
  const parsed = typeof query === 'string' ? parse(query) : query;
  const out = [`Query — ${parsed.parts.length} part${parsed.parts.length === 1 ? '' : 's'}`];

  parsed.parts.forEach((part, i) => {
    const op = i > 0 ? parsed.ops[i - 1] : undefined;

    if (op) {
      out.push(`  ${op.op.toUpperCase()}${op.all ? ' ALL' : ''}`);
    }

    for (const clause of part.clauses) {
      if (graph && clause.kind === 'match') {
        for (const line of matchPlan(graph, clause, params)) {
          out.push(`  ${line}`);
        }
      } else {
        out.push(`  ${clauseLine(clause)}`);
      }
    }
  });

  return out.join('\n');
};
