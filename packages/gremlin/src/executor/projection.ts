import type { Graph } from '@pl-graph/core';

import type { By } from '../ast.js';
import {
  evalBy,
  extend,
  firstLabel,
  isEdge,
  isVertex,
  type Pop,
  recallTag,
  type RunContext,
  startTraverser,
  type Traverser,
} from './runtime.js';

export const groupStep = function* (
  stream: Iterable<Traverser<unknown>>,
  keyBy: By,
  valueBy: By,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const result = new Map<unknown, unknown[]>();
  for (const t of stream) {
    const k = evalBy(keyBy, t.value, graph, ctx);
    const v = evalBy(valueBy, t.value, graph, ctx);
    const list = result.get(k);
    if (list) {
      list.push(v);
    } else {
      result.set(k, [v]);
    }
  }
  yield startTraverser(result);
};

export const groupCountStep = function* (
  stream: Iterable<Traverser<unknown>>,
  by: By,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const result = new Map<unknown, number>();
  for (const t of stream) {
    const k = evalBy(by, t.value, graph, ctx);
    result.set(k, (result.get(k) ?? 0) + 1);
  }
  yield startTraverser(result);
};

export const projectStep = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const by = bys?.[i] ?? { kind: 'identity' as const };
      out[keys[i]!] = evalBy(by, t.value, graph, ctx);
    }
    yield extend(t, out);
  }
};

export const projectValues = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    if (keys.length === 0) {
      for (const v of Object.values(props)) {
        yield extend(t, v);
      }
    } else {
      for (const key of keys) {
        if (key in props) {
          yield extend(t, props[key]);
        }
      }
    }
  }
};

export const projectValueMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    if (!keys || keys.length === 0) {
      yield extend(t, { ...props });
    } else {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in props) {
          out[k] = props[k];
        }
      }
      yield extend(t, out);
    }
  }
};

// `path()` yields the array of values seen on the way to the current
// traverser. With `bys`, each path element is projected via `bys[i % bys.length]`
// — Gremlin's documented cycling semantics.
export const pathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!bys || bys.length === 0) {
      yield extend(t, [...t.path]);
      continue;
    }
    const out = t.path.map((v, i) => evalBy(bys[i % bys.length]!, v, graph, ctx));
    yield extend(t, out);
  }
};

// `elementMap(...keys?)` projects each element to `{ id, label, ...properties }`.
// With no keys, all properties are included; with keys, only those.
//
// Edges additionally get `IN` and `OUT` submaps holding `{ id, label }` for
// the in/out vertex — matching the Gremlin reference output for
// `g.E().elementMap()`. Vertices have no IN/OUT.
export const projectElementMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const out: Record<string, unknown> = {
      id: t.value.id,
      label: firstLabel(t.value.labels) ?? null,
    };
    if (isEdge(t.value)) {
      out.IN = {
        id: t.value.to.id,
        label: firstLabel(t.value.to.labels) ?? null,
      };
      out.OUT = {
        id: t.value.from.id,
        label: firstLabel(t.value.from.labels) ?? null,
      };
    }
    const targetKeys = keys && keys.length > 0 ? keys : Object.keys(props);
    for (const k of targetKeys) {
      if (k in props) {
        out[k] = props[k];
      }
    }
    yield extend(t, out);
  }
};

// `propertyMap(...keys?)` yields a single map of `{ key: [values...] }` per element.
// Each value is wrapped in an array to mimic Gremlin's multi-property semantics
// (even though our property model is single-valued).
export const projectPropertyMap = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[] | undefined,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const out: Record<string, unknown[]> = {};
    const targetKeys = keys && keys.length > 0 ? keys : Object.keys(props);
    for (const k of targetKeys) {
      if (k in props) {
        out[k] = [props[k]];
      }
    }
    yield extend(t, out);
  }
};

// `properties(...keys)` yields one `{ key, value }` object per matched property,
// flattening across multiple keys per element. With no keys, yields all
// properties of the element.
export const projectProperties = function* (
  stream: Iterable<Traverser<unknown>>,
  keys: readonly string[],
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value) && !isEdge(t.value)) {
      continue;
    }
    const props = t.value.properties;
    const targetKeys = keys.length === 0 ? Object.keys(props) : keys;
    for (const key of targetKeys) {
      if (key in props) {
        yield extend(t, { key, value: props[key] });
      }
    }
  }
};

export const asStep = function* (
  stream: Iterable<Traverser<unknown>>,
  label: string,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const tags = new Map<string, readonly unknown[]>(t.tags);
    const existing = tags.get(label) ?? [];
    tags.set(label, [...existing, t.value]);
    yield { ...t, tags };
  }
};

export const selectStep = function* (
  stream: Iterable<Traverser<unknown>>,
  labels: readonly string[],
  pop: Pop,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // bys[i] modulates the projection for labels[i]; missing entries fall
  // through to identity. Gremlin also allows a single `by()` to apply to all
  // labels — for the simple case we only honor positional `bys`.
  const byFor = (i: number): By => bys?.[i] ?? { kind: 'identity' };
  for (const t of stream) {
    if (labels.length === 1) {
      const lbl = labels[0]!;
      const r = recallTag(t.tags, lbl, pop);
      if (!r.ok) {
        continue;
      }
      yield extend(t, evalBy(byFor(0), r.value, graph, ctx));
      continue;
    }
    const out: Record<string, unknown> = {};
    let missing = false;
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i]!;
      const r = recallTag(t.tags, lbl, pop);
      if (!r.ok) {
        missing = true;
        break;
      }
      out[lbl] = evalBy(byFor(i), r.value, graph, ctx);
    }
    if (missing) {
      continue;
    }
    yield extend(t, out);
  }
};

// `tree()` collects each traverser's path into a nested map. Each path
// becomes a chain of map keys: path[0] -> path[1] -> ... -> {}.
export const treeStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[] | undefined,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const root = new Map<unknown, unknown>();
  for (const t of stream) {
    let cursor = root;
    t.path.forEach((node, i) => {
      // by(...) modulators are applied round-robin to successive path
      // positions, matching `path()`'s by-rotation semantics.
      const key = bys && bys.length > 0 ? evalBy(bys[i % bys.length]!, node, graph, ctx) : node;
      let next = cursor.get(key) as Map<unknown, unknown> | undefined;
      if (!next) {
        next = new Map<unknown, unknown>();
        cursor.set(key, next);
      }
      cursor = next;
    });
  }
  yield startTraverser(root);
};
