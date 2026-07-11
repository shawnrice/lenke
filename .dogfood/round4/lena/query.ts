/**
 * A tiny fluent query builder that compiles to ISO GQL and runs via @lenke/gql.
 *
 *   from(schema, graph, 'User').where('age', '>', 30).orderBy('name').limit(5)
 *     .return('name', 'email')
 *
 * compiles to:
 *   MATCH (n:User) WHERE n.age > $p0 RETURN n.name AS name, n.email AS email
 *     ORDER BY n.name ASC LIMIT 5
 * and executes it with the bound params.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { Schema } from './schema.js';

type Op = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'CONTAINS' | 'STARTS WITH' | 'ENDS WITH';

interface Cond {
  field: string;
  op: Op;
  value: unknown;
}

export class QueryBuilder {
  private conds: Cond[] = [];
  private orderField?: string;
  private orderDir: 'ASC' | 'DESC' = 'ASC';
  private limitN?: number;

  constructor(
    private readonly graph: Graph,
    private readonly schema: Schema,
    private readonly label: string,
  ) {
    if (!schema.entities.has(label)) throw new Error(`unknown entity '${label}'`);
  }

  where(field: string, op: Op, value: unknown): this {
    this.assertField(field);
    this.conds.push({ field, op, value });
    return this;
  }

  orderBy(field: string, dir: 'ASC' | 'DESC' = 'ASC'): this {
    this.assertField(field);
    this.orderField = field;
    this.orderDir = dir;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private assertField(field: string): void {
    const entity = this.schema.entities.get(this.label)!;
    if (!(field in entity.properties)) {
      throw new Error(`${this.label} has no property '${field}' (query builder is schema-checked)`);
    }
  }

  /** Compile to a GQL string + params bag without running. */
  compile(...fields: string[]): { gql: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = {};
    let clause = `MATCH (n:${this.label})`;
    if (this.conds.length > 0) {
      const parts = this.conds.map((c, i) => {
        const p = `p${i}`;
        params[p] = c.value;
        return `n.${c.field} ${c.op} $${p}`;
      });
      clause += ` WHERE ${parts.join(' AND ')}`;
    }
    const returned = fields.length > 0 ? fields : Object.keys(this.schema.entities.get(this.label)!.properties);
    clause += ` RETURN ${returned.map((f) => `n.${f} AS ${f}`).join(', ')}`;
    if (this.orderField) clause += ` ORDER BY n.${this.orderField} ${this.orderDir}`;
    if (this.limitN !== undefined) clause += ` LIMIT ${this.limitN}`;
    return { gql: clause, params };
  }

  /** Compile + execute. */
  return(...fields: string[]): Record<string, unknown>[] {
    const { gql, params } = this.compile(...fields);
    return query(this.graph, gql, params);
  }
}

export function from(graph: Graph, schema: Schema, label: string): QueryBuilder {
  return new QueryBuilder(graph, schema, label);
}
