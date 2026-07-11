/**
 * CSV import + validation tool: parse a Neo4j-style paired node/edge CSV into a
 * lenke Graph, validate it, and report. Uses lenke's paired-file CSV codec
 * (decodeNodes/decodeEdges) for the actual graph build; does its own row-level
 * pass for duplicate-id detection (the codec silently dedupes duplicate ids —
 * see packages/core/src/core/Graph.ts:396 — so a validator can't rely on it).
 */
import { Graph } from '@lenke/core';

import { decodeNodes, decodeEdges } from './paired-csv.ts';

export type Severity = 'error' | 'warning';
export interface Issue {
  severity: Severity;
  kind: string;
  message: string;
}

/** Per-label required property keys (a tiny schema for the demo). */
export type RequiredProps = Record<string, readonly string[]>;

/**
 * Minimal RFC-4180 record splitter — returns each record's first N raw cells.
 * Needed only for validation (duplicate ids, column-count); the library exposes
 * no row-level parser, only whole-graph decode.
 */
function firstCells(csv: string, n: number): { cells: string[]; recordCount: number }[] {
  const out: { cells: string[]; recordCount: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQ = false;
  let started = false;
  const flushField = () => {
    cells.push(field);
    field = '';
  };
  const flushRow = () => {
    flushField();
    out.push({ cells: cells.slice(0, n), recordCount: cells.length });
    cells = [];
    started = false;
  };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    started = true;
    if (inQ) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') flushField();
    else if (c === '\r') continue;
    else if (c === '\n') flushRow();
    else field += c;
  }
  if (started || field || cells.length) flushRow();
  return out;
}

export interface ImportResult {
  graph: Graph;
  issues: Issue[];
  stats: { nodeRows: number; edgeRows: number; vertices: number; edges: number };
}

/**
 * Import a paired CSV. Validation is non-fatal for node issues (they are
 * reported); a dangling edge is fatal to the strict `decodeEdges` batch call,
 * so we pre-filter dangling edge rows and report them rather than throw.
 */
export function importPairedCsv(
  nodesCsv: string,
  edgesCsv: string,
  required: RequiredProps = {},
): ImportResult {
  const issues: Issue[] = [];
  const graph = new Graph();

  // ---- Node validation: duplicate ids + malformed column counts ----
  const nodeHeader = firstCells(nodesCsv, 2)[0];
  const nodeCols = nodeHeader?.recordCount ?? 0;
  const nodeRows = firstCells(nodesCsv, 1).slice(1);
  const seenNode = new Set<string>();
  for (const { cells, recordCount } of firstCells(nodesCsv, 2).slice(1)) {
    const id = cells[0];
    if (seenNode.has(id)) {
      issues.push({
        severity: 'error',
        kind: 'duplicate-node-id',
        message: `node id '${id}' appears more than once (the codec keeps the first, drops the rest)`,
      });
    }
    seenNode.add(id);
    if (recordCount !== nodeCols) {
      issues.push({
        severity: 'error',
        kind: 'malformed-node-row',
        message: `node id '${id}' has ${recordCount} columns, header has ${nodeCols}`,
      });
    }
  }

  // ---- Build the vertices via the library codec ----
  decodeNodes(nodesCsv, graph);

  // ---- Required-property validation (post-decode, typed) ----
  for (const vertex of graph.vertices) {
    for (const label of vertex.labels) {
      for (const key of required[label] ?? []) {
        const v = vertex.getProperty(key);
        if (v === undefined || v === null || v === '') {
          issues.push({
            severity: 'error',
            kind: 'missing-required-property',
            message: `${label} '${vertex.id}' missing required property '${key}'`,
          });
        }
      }
    }
  }

  // ---- Edge validation: dangling endpoints (pre-filter so the strict batch
  //      decode doesn't throw), duplicate edge ids ----
  const edgeHeader = firstCells(edgesCsv, 4)[0];
  const edgeCols = edgeHeader?.recordCount ?? 0;
  const edgeRows = firstCells(edgesCsv, 4).slice(1);
  const seenEdge = new Set<string>();
  const goodEdgeRows: string[] = [edgesCsv.split('\n')[0]!]; // keep header line
  // Re-emit only non-dangling edge records. We rebuild a clean edges CSV from
  // the raw records so decodeEdges (strict) never sees a dangling endpoint.
  const rawEdgeRecords = splitRecords(edgesCsv).slice(1);
  const parsedEdgeRows = firstCells(edgesCsv, 4).slice(1);
  for (let i = 0; i < parsedEdgeRows.length; i++) {
    const { cells } = parsedEdgeRows[i]!;
    const [id, from, to] = cells;
    let dangling = false;
    if (seenEdge.has(id)) {
      issues.push({
        severity: 'error',
        kind: 'duplicate-edge-id',
        message: `edge id '${id}' appears more than once`,
      });
    }
    seenEdge.add(id);
    if (!graph.getVertexById(from!)) {
      dangling = true;
      issues.push({
        severity: 'error',
        kind: 'dangling-edge',
        message: `edge '${id}' :START_ID '${from}' references a missing node`,
      });
    }
    if (!graph.getVertexById(to!)) {
      dangling = true;
      issues.push({
        severity: 'error',
        kind: 'dangling-edge',
        message: `edge '${id}' :END_ID '${to}' references a missing node`,
      });
    }
    if (!dangling) goodEdgeRows.push(rawEdgeRecords[i]!);
  }

  // ---- Build the (non-dangling) edges via the library codec ----
  decodeEdges(goodEdgeRows.join('\n'), graph);

  return {
    graph,
    issues,
    stats: {
      nodeRows: nodeRows.length,
      edgeRows: edgeRows.length,
      vertices: graph.vertexCount,
      edges: graph.edgeCount,
    },
  };
}

/** Whole-record splitter (quote-aware) so multi-line quoted fields stay intact. */
export function splitRecords(csv: string): string[] {
  const out: string[] = [];
  let rec = '';
  let inQ = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inQ) {
      if (c === '"' && csv[i + 1] === '"') {
        rec += '""';
        i++;
      } else if (c === '"') {
        inQ = false;
        rec += '"';
      } else {
        rec += c;
      }
      continue;
    }
    if (c === '"') {
      inQ = true;
      rec += '"';
    } else if (c === '\n') {
      out.push(rec);
      rec = '';
    } else {
      rec += c;
    }
  }
  if (rec !== '') out.push(rec);
  return out;
}
