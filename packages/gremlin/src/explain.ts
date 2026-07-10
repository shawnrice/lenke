import type { Plan, Step } from './ast.js';

const isPlan = (value: unknown): value is Plan =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { steps?: unknown }).steps);

// A compact JSON of a step's own arguments: its fields that aren't the `kind`
// discriminant, a nested sub-plan, or a function (labels, keys, counts, …).
const args = (step: Step): string => {
  const scalar: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(step)) {
    if (key === 'kind' || typeof value === 'function' || isPlan(value)) {
      continue;
    }

    if (Array.isArray(value) && value.every(isPlan)) {
      continue;
    }

    scalar[key] = value;
  }

  if (Object.keys(scalar).length === 0) {
    return '';
  }

  try {
    return ` ${JSON.stringify(scalar)}`;
  } catch {
    return ` {${Object.keys(scalar).join(', ')}}`;
  }
};

// The sub-plans a step nests (`where`, `repeat`, `union`, `optional`, …), each
// labeled by the field it came from.
const subPlans = (step: Step): Array<{ label: string; plan: Plan }> => {
  const out: Array<{ label: string; plan: Plan }> = [];

  for (const [key, value] of Object.entries(step)) {
    if (isPlan(value)) {
      out.push({ label: key, plan: value });
    } else if (Array.isArray(value) && value.every(isPlan)) {
      value.forEach((plan, i) => out.push({ label: `${key}[${i}]`, plan }));
    }
  }

  return out;
};

const lines = (plan: Plan, depth: number): string[] =>
  plan.steps.flatMap((step) => {
    const nested = subPlans(step).flatMap(({ label, plan: sub }) => [
      `${'  '.repeat(depth + 1)}${label}:`,
      ...lines(sub, depth + 2),
    ]);

    return [`${'  '.repeat(depth)}${step.kind}${args(step)}`, ...nested];
  });

/**
 * Render a traversal's plan — its `Step` sequence, with nested sub-traversals
 * (`where`, `repeat`, `union`, …) indented beneath their step. This is the
 * actual plan the executor walks, so it's a faithful EXPLAIN:
 *
 * ```text
 * V
 * hasLabel {"labels":["Person"]}
 * where
 *   out {"labels":["KNOWS"]}
 * values {"keys":["name"]}
 * ```
 */
export const explain = (plan: Plan): string => {
  const rendered = lines(plan, 0);

  return rendered.length > 0 ? rendered.join('\n') : '(empty plan)';
};
