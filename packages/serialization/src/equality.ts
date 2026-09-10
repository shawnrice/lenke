import type { Graph } from '@lenke/core';

const sameMap = (x: Map<string, string>, y: Map<string, string>): boolean =>
  x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);

// `JSON.stringify` collapses every non-finite number and negative zero to a form that
// can't be told apart — NaN / ±Infinity all serialize as `null` (indistinguishable from a
// real `null`), and `-0` serializes as `0`. So a round trip that corrupts, say, `Infinity`
// into `NaN` (or `NaN` into `null`) would canon-compare EQUAL and the conformance verifier
// would miss it. This replacer maps each to a distinct sentinel string so the canonical form
// preserves them. (Also runs on nested list/record values.)
const preserveNonFinite = (_key: string, value: unknown): unknown => {
  if (typeof value !== 'number') {
    return value;
  }

  if (Number.isNaN(value)) {
    return '@NaN';
  }

  if (value === Infinity) {
    return '@Inf';
  }

  if (value === -Infinity) {
    return '@-Inf';
  }

  return Object.is(value, -0) ? '@-0' : value;
};

const canon = (labels: Iterable<string>, props: Record<string, unknown>): string => {
  const labelPart = JSON.stringify([...labels].sort());
  const propPart = JSON.stringify(
    Object.keys(props)
      .sort()
      .map((k) => [k, props[k]]),
    preserveNonFinite,
  );

  return `${labelPart}|${propPart}`;
};

/**
 * Structural equality of two graphs in the LPG model: same node ids with the
 * same labels (as sets) and properties, and same edges **by id** with the same
 * endpoints, labels, and properties. Order-independent.
 *
 * This is the check for verifying a round trip — `graphContentEqual(deserialize
 * (serialize(g, fmt), fmt), g)` — and is exactly what the codec conformance
 * suite uses. Because it compares **by id**, a lossy codec that mints fresh ids
 * (e.g. `pg-text` for edges) will correctly report NOT equal after a round trip;
 * that's real identity loss, not a false negative.
 */
export const graphContentEqual = (a: Graph, b: Graph): boolean => {
  const nodeMap = (g: Graph): Map<string, string> =>
    new Map([...g.vertices].map((v) => [String(v.id), canon(v.labels, v.properties)]));
  const edgeMap = (g: Graph): Map<string, string> =>
    new Map(
      [...g.edges].map((e) => [
        String(e.id),
        `${e.from.id}->${e.to.id}|${canon(e.labels, e.properties)}`,
      ]),
    );

  return sameMap(nodeMap(a), nodeMap(b)) && sameMap(edgeMap(a), edgeMap(b));
};
