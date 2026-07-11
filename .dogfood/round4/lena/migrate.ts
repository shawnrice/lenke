/**
 * A minimal migration runner. Migrations transform an existing graph in place
 * and are recorded as `:_Migration {id}` vertices in the graph itself, so a
 * re-run is idempotent (already-applied migrations are skipped).
 *
 * Migrations run with graph events DISABLED: an in-flight transform (renaming a
 * label, backfilling a not-yet-declared property) would otherwise be vetoed by
 * the very schema constraints the migration is establishing. This is the
 * migration analogue of "defer constraints" in SQL.
 */
import { Graph, type Vertex } from '@lenke/core';

export interface Migration {
  id: string;
  up: (ctx: MigrationContext) => void;
}

export interface MigrationContext {
  graph: Graph;
  /** all vertices carrying `label` */
  byLabel: (label: string) => Set<Vertex>;
}

const MIGRATION_LABEL = '_Migration';

function applied(graph: Graph): Set<string> {
  const out = new Set<string>();
  for (const v of graph.getVerticesByLabel(MIGRATION_LABEL)) {
    out.add(v.getProperty<string>('id'));
  }
  return out;
}

export function migrate(graph: Graph, migrations: Migration[]): string[] {
  const done = applied(graph);
  const ran: string[] = [];
  const eventsWere = graph.eventsEnabled();
  graph.disableEvents();
  try {
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      m.up({
        graph,
        byLabel: (label) => graph.getVerticesByLabel(label),
      });
      graph.addVertex({
        labels: [MIGRATION_LABEL],
        properties: { id: m.id, appliedAt: new Date('2026-07-11').toISOString() },
      });
      ran.push(m.id);
    }
  } finally {
    if (eventsWere) graph.enableEvents();
  }
  return ran;
}
