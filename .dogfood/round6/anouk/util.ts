import type { Graph } from '@lenke/core';
import { createTestTinkerGraph, run, toArray } from '@lenke/gremlin';

export { createTestTinkerGraph };

export const g: Graph = createTestTinkerGraph();

// Render a result element compactly: vertex/edge -> name or id; primitives raw.
export function show(v: unknown): unknown {
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v.entries()) o[String(k)] = show(val);
    return o;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('properties' in o && o.properties && typeof o.properties === 'object') {
      const p = o.properties as Record<string, unknown>;
      if ('name' in p) return p.name;
      // edge? show label
      if ('labels' in o) return `<${(o.labels as string[])?.join(',')}:${o.id}>`;
      return o.id ?? o;
    }
    if (Array.isArray(v)) return v.map(show);
    if ('id' in o && 'labels' in o) return o.id;
    // plain map result
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = show(o[k]);
    return out;
  }
  return v;
}

export function res(plan: unknown, graph: Graph = g): unknown[] {
  return (toArray as (p: unknown, gr: Graph) => unknown[])(plan, graph).map(show);
}

export function raw(plan: unknown, graph: Graph = g): unknown[] {
  return (toArray as (p: unknown, gr: Graph) => unknown[])(plan, graph);
}

export function label(title: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const mark = a === e ? 'OK ' : 'XX ';
  console.log(`${mark}${title}`);
  console.log(`     actual:   ${a}`);
  if (expected !== undefined) console.log(`     expected: ${e}`);
}

export { run };
