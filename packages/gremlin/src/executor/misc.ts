// `math(expr)` — evaluate a tiny infix arithmetic expression. Supports numeric
// literals, parens, `+ - * /`, the identifier `_` (the current traverser value),
// and other identifiers referencing `as_`-bound labels. Operands are projected
// by the `.by(...)` modulator(s) in first-appearance order, cycling — so
// `math('a + b').by('age')` sums the `age` of the values tagged `a` and `b`.

import type { Graph } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { By, Step } from '../ast.js';
import { evalBy, extend, recallTag, type RunContext, type Traverser } from './runtime.js';

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

// The distinct identifiers in `expr`, in first-appearance order. Used to map
// `by()` modulators to operands (TinkerPop cycles them in this order).
const mathVars = (expr: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const m of expr.matchAll(IDENT)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }

  return out;
};

export const mathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'math' }>,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const bys = step.bys ?? [];
  const vars = mathVars(step.expr);
  const byFor = (name: string): By =>
    bys.length > 0 ? bys[vars.indexOf(name) % bys.length] : { kind: 'identity' };

  for (const t of stream) {
    const resolve = (name: string): number => {
      // `_` is the current value; any other name is an as_-bound tag.
      let base: unknown;

      if (name === '_') {
        base = t.value;
      } else {
        const r = recallTag(t.tags, name, 'last');

        if (!r.ok) {
          throw new PlGraphError(`math: unbound variable '${name}' in '${step.expr}'`, {
            code: ErrorCode.Unsupported,
          });
        }

        base = r.value;
      }

      return Number(evalBy(byFor(name), base, graph, ctx));
    };

    yield extend(t, evalMath(step.expr, resolve));
  }
};

// Recursive-descent parser for tiny arithmetic. `resolve` maps an identifier
// (incl. `_`) to its numeric value. Returns the evaluated number.
export const evalMath = (expr: string, resolve: (name: string) => number): number => {
  let pos = 0;
  const peek = (): string => expr[pos] ?? '';
  const skip = () => {
    while (pos < expr.length && /\s/.test(expr[pos])) {
      pos++;
    }
  };
  const parsePrimary = (): number => {
    skip();
    const ch = peek();

    if (ch === '(') {
      pos++;
      const v = parseAdd();
      skip();

      if (peek() !== ')') {
        throw new Error(`math: expected ')' in ${expr}`);
      }

      pos++;

      return v;
    }

    // Identifier (`_` or an as_-bound name) — resolved by the caller.
    if (/[A-Za-z_]/.test(ch)) {
      const idStart = pos;

      while (pos < expr.length && /[A-Za-z0-9_]/.test(expr[pos])) {
        pos++;
      }

      return resolve(expr.slice(idStart, pos));
    }

    // Number literal (integer or decimal).
    const start = pos;

    if (ch === '-' || ch === '+') {
      pos++;
    }

    while (pos < expr.length && /[0-9.]/.test(expr[pos])) {
      pos++;
    }

    if (start === pos) {
      throw new Error(`math: unexpected '${ch}' in ${expr}`);
    }

    const lit = expr.slice(start, pos);
    const n = Number(lit);

    if (Number.isNaN(n)) {
      throw new Error(`math: bad number '${lit}' in ${expr}`);
    }

    return n;
  };
  const parseMul = (): number => {
    let left = parsePrimary();
    skip();

    while (peek() === '*' || peek() === '/') {
      const op = peek();
      pos++;
      const right = parsePrimary();
      left = op === '*' ? left * right : left / right;
      skip();
    }

    return left;
  };
  const parseAdd = (): number => {
    let left = parseMul();
    skip();

    while (peek() === '+' || peek() === '-') {
      const op = peek();
      pos++;
      const right = parseMul();
      left = op === '+' ? left + right : left - right;
      skip();
    }

    return left;
  };
  const result = parseAdd();
  skip();

  if (pos < expr.length) {
    throw new Error(`math: trailing input '${expr.slice(pos)}' in ${expr}`);
  }

  return result;
};
