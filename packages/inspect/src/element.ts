import type { Edge, Vertex } from '@lenke/core';

import { literal } from './value.js';

const isEdge = (element: Vertex | Edge): element is Edge => 'from' in element && 'to' in element;

const propBag = (properties: Record<string, unknown>): string => {
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return '';
  }

  return ` { ${entries.map(([key, value]) => `${key}: ${literal(value)}`).join(', ')} }`;
};

/**
 * A single vertex or edge as a compact, readable line:
 *
 * ```text
 * (#1 :Person { name: "marko", age: 29 })
 * [#7 :KNOWS { weight: 0.5 }] (#1 → #2)
 * ```
 */
export const formatElement = (element: Vertex | Edge): string => {
  const labels = [...element.labels].map((label) => `:${label}`).join('');
  const props = propBag(element.properties);

  if (isEdge(element)) {
    return `[#${element.id} ${labels}${props}] (#${element.from.id} → #${element.to.id})`;
  }

  return `(#${element.id} ${labels}${props})`;
};
