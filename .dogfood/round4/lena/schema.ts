/**
 * graphene — a tiny "Prisma for graphs" schema/validation layer on @lenke/core.
 *
 * Provides typed entity definitions, write-time constraint enforcement built on
 * the graph mutation-event veto (`preventDefault`), unique-key indexes backed by
 * `createVertexIndex`, relationship cardinality, and a place to hang migrations.
 *
 * Design note on the veto model: a vetoed core mutation is SILENT — `addVertex`
 * returns the (un-attached) vertex, `setProperty` returns void. To behave like a
 * real ORM (throw on violation), every constraint listener records a structured
 * `Violation` into `pendingViolations` *and* calls `preventDefault()`. The
 * repository wrappers drain that buffer after each core call and throw. That is
 * the single most important thing you must hand-build on top of lenke.
 */
import { Graph, type Vertex, type Edge } from '@lenke/core';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export type ScalarType = 'string' | 'number' | 'boolean';

export interface PropertyDef {
  type: ScalarType;
  required?: boolean;
  unique?: boolean;
  /** value used to backfill during migrations / when omitted at create time */
  default?: string | number | boolean;
}

export interface EntityDef {
  label: string;
  properties: Record<string, PropertyDef>;
}

/** Cardinality on the `to` side of a directed relationship. */
export type Cardinality = 'one' | 'many';

export interface RelationshipDef {
  /** edge label, e.g. 'AUTHORED' */
  label: string;
  from: string; // entity label
  to: string; // entity label
  /**
   * How many `to` targets one `from` source may point at over this edge label
   * (source fan-out), and how many `from` sources may point at one `to`
   * (target fan-in). "a post has exactly one author" => fromMany target has
   * `inbound: 'one'`.
   */
  outbound?: Cardinality; // default 'many'
  inbound?: Cardinality; // default 'many'
  /** if true, deleting the `from` vertex cascades to delete `to` vertices reached by this edge */
  cascadeDelete?: boolean;
}

export interface Violation {
  kind: 'required' | 'type' | 'unique' | 'cardinality' | 'unknown-property';
  entity?: string;
  field?: string;
  message: string;
}

export class ConstraintError extends Error {
  constructor(public readonly violations: Violation[]) {
    super(
      `constraint violation:\n  - ` +
        violations.map((v) => `[${v.kind}] ${v.message}`).join('\n  - '),
    );
    this.name = 'ConstraintError';
  }
}

// ---------------------------------------------------------------------------
// Schema — wires event listeners onto a graph and enforces constraints.
// ---------------------------------------------------------------------------

export class Schema {
  readonly entities = new Map<string, EntityDef>();
  readonly relationships: RelationshipDef[] = [];
  private unsubscribers: Array<() => void> = [];
  private pending: Violation[] = [];
  private graph!: Graph;

  entity(def: EntityDef): this {
    this.entities.set(def.label, def);
    return this;
  }

  relationship(def: RelationshipDef): this {
    this.relationships.push(def);
    return this;
  }

  private typeOf(v: unknown): ScalarType | 'null' | 'other' {
    if (v === null) return 'null';
    if (typeof v === 'string') return 'string';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    return 'other';
  }

  private entityFor(labels: Set<string>): EntityDef | undefined {
    for (const label of labels) {
      const e = this.entities.get(label);
      if (e) return e;
    }
    return undefined;
  }

  /** Validate a full property bag for an entity; push violations, return count added. */
  private checkBag(entity: EntityDef, props: Record<string, unknown>): number {
    const before = this.pending.length;
    for (const [key, def] of Object.entries(entity.properties)) {
      const present = key in props && props[key] !== undefined;
      if (def.required && (!present || props[key] === null)) {
        this.pending.push({
          kind: 'required',
          entity: entity.label,
          field: key,
          message: `${entity.label}.${key} is required`,
        });
        continue;
      }
      if (present && props[key] !== null) {
        const actual = this.typeOf(props[key]);
        if (actual !== def.type) {
          this.pending.push({
            kind: 'type',
            entity: entity.label,
            field: key,
            message: `${entity.label}.${key} must be ${def.type}, got ${actual} (${JSON.stringify(props[key])})`,
          });
        }
      }
    }
    // unknown-property: strict-mode reject props not in the schema
    for (const key of Object.keys(props)) {
      if (!(key in entity.properties)) {
        this.pending.push({
          kind: 'unknown-property',
          entity: entity.label,
          field: key,
          message: `${entity.label} has no property '${key}' in schema`,
        });
      }
    }
    return this.pending.length - before;
  }

  private checkUnique(entity: EntityDef, key: string, value: unknown, self: Vertex): boolean {
    const def = entity.properties[key];
    if (!def?.unique || value === undefined || value === null) return true;
    // O(1) index seek; requires createVertexIndex(key), done in attach().
    const others = this.graph.getVerticesByProperty(key, value);
    for (const other of others) {
      if (other.id !== self.id && other.labels.has(entity.label)) {
        this.pending.push({
          kind: 'unique',
          entity: entity.label,
          field: key,
          message: `${entity.label}.${key} = ${JSON.stringify(value)} already exists (id ${other.id})`,
        });
        return false;
      }
    }
    return true;
  }

  /** Attach enforcement to a graph: create indexes + subscribe listeners. */
  attach(graph: Graph): this {
    this.graph = graph;
    // Build unique indexes so the uniqueness check is an index seek, not a scan.
    for (const entity of this.entities.values()) {
      for (const [key, def] of Object.entries(entity.properties)) {
        if (def.unique) graph.createVertexIndex(key);
      }
    }

    // --- Vertex insert: required + type + unknown-prop + unique -------------
    this.unsubscribers.push(
      graph.on('@graph/VertexAdded', (e) => {
        const v = e.value;
        const entity = this.entityFor(v.labels);
        if (!entity) return;
        const props = v.properties;
        let bad = this.checkBag(entity, props);
        for (const [key, def] of Object.entries(entity.properties)) {
          if (def.unique) if (!this.checkUnique(entity, key, props[key], v)) bad++;
        }
        if (bad > 0) e.preventDefault();
      }),
    );

    // --- Property change: type + unique on the single changed key ----------
    this.unsubscribers.push(
      graph.on('@graph/VertexPropertyChanged', (e) => {
        const { vertex, key, value } = e.value;
        const entity = this.entityFor(vertex.labels);
        if (!entity) return;
        const def = entity.properties[key];
        const before = this.pending.length;
        if (!def) {
          this.pending.push({
            kind: 'unknown-property',
            entity: entity.label,
            field: key,
            message: `${entity.label} has no property '${key}' in schema`,
          });
        } else {
          if (value !== null && value !== undefined) {
            const actual = this.typeOf(value);
            if (actual !== def.type)
              this.pending.push({
                kind: 'type',
                entity: entity.label,
                field: key,
                message: `${entity.label}.${key} must be ${def.type}, got ${actual}`,
              });
          }
          if (def.required && (value === null || value === undefined))
            this.pending.push({
              kind: 'required',
              entity: entity.label,
              field: key,
              message: `${entity.label}.${key} is required (cannot set null)`,
            });
          this.checkUnique(entity, key, value, vertex);
        }
        if (this.pending.length > before) e.preventDefault();
      }),
    );

    // --- Property removal: block dropping a required key --------------------
    this.unsubscribers.push(
      graph.on('@graph/VertexPropertyRemoved', (e) => {
        const { vertex, key } = e.value;
        const entity = this.entityFor(vertex.labels);
        const def = entity?.properties[key];
        if (def?.required) {
          this.pending.push({
            kind: 'required',
            entity: entity!.label,
            field: key,
            message: `${entity!.label}.${key} is required; cannot remove`,
          });
          e.preventDefault();
        }
      }),
    );

    // --- Edge insert: cardinality -----------------------------------------
    this.unsubscribers.push(
      graph.on('@graph/EdgeAdded', (e) => {
        const edge = e.value;
        const before = this.pending.length;
        for (const rel of this.relationships) {
          if (!edge.labels.has(rel.label)) continue;
          // inbound 'one': target may have at most one incoming edge of this label
          if (rel.inbound === 'one') {
            const existing = edge.to.edgesToByLabel(rel.label);
            for (const other of existing) {
              if (other.id !== edge.id) {
                this.pending.push({
                  kind: 'cardinality',
                  message: `${rel.to} already has an inbound :${rel.label} (max one); id ${edge.to.id}`,
                });
                break;
              }
            }
          }
          // outbound 'one': source may have at most one outgoing edge of this label
          if (rel.outbound === 'one') {
            const existing = edge.from.edgesFromByLabel(rel.label);
            for (const other of existing) {
              if (other.id !== edge.id) {
                this.pending.push({
                  kind: 'cardinality',
                  message: `${rel.from} already has an outbound :${rel.label} (max one); id ${edge.from.id}`,
                });
                break;
              }
            }
          }
        }
        if (this.pending.length > before) e.preventDefault();
      }),
    );

    return this;
  }

  /** Drain and clear the pending-violation buffer. */
  drain(): Violation[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  detach(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }
}
