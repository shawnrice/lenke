import type { Edge, Vertex } from '@lenke/core';

import { styleFor, type ColorOption, type Style } from './color.js';

const isEdge = (element: Vertex | Edge): element is Edge => 'from' in element && 'to' in element;

const propValue = (value: unknown, style: Style): string => {
  if (value === null) {
    return style.dim('null');
  }

  if (typeof value === 'string') {
    return style.yellow(JSON.stringify(value));
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
};

const propBag = (properties: Record<string, unknown>, style: Style): string => {
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return '';
  }

  return ` { ${entries.map(([key, value]) => `${key}: ${propValue(value, style)}`).join(', ')} }`;
};

/**
 * A single vertex or edge as a compact, readable line:
 *
 * ```text
 * (#1 :Person { name: "marko", age: 29 })
 * [#7 :KNOWS { weight: 0.5 }] (#1 → #2)
 * ```
 */
export const formatElement = (element: Vertex | Edge, options: ColorOption = {}): string => {
  const style = styleFor(options.color);
  const labels = [...element.labels].map((label) => style.cyan(`:${label}`)).join('');
  const props = propBag(element.properties, style);
  const id = style.dim(`#${element.id}`);

  if (isEdge(element)) {
    const from = style.dim(`#${element.from.id}`);
    const to = style.dim(`#${element.to.id}`);

    return `[${id} ${labels}${props}] (${from} ${style.dim('→')} ${to})`;
  }

  return `(${id} ${labels}${props})`;
};
