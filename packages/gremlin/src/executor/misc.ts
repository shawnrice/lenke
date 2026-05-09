// `math(expr)` — evaluate a tiny infix arithmetic expression. Supports
// numeric literals, parens, `+ - * /`, and the identifier `_` referring to
// the current traverser value (coerced to Number). Other identifiers throw —
// full Gremlin math() with `as`-bound names is not yet supported.

import { extend, type Traverser } from './runtime.js';

export const mathStep = function* (
  stream: Iterable<Traverser<unknown>>,
  expr: string,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield extend(t, evalMath(expr, Number(t.value)));
  }
};

// Recursive-descent parser for tiny arithmetic. Returns the evaluated number.
export const evalMath = (expr: string, current: number): number => {
  let pos = 0;
  const peek = (): string => expr[pos] ?? '';
  const skip = () => {
    while (pos < expr.length && /\s/.test(expr[pos]!)) {
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
    if (ch === '_') {
      pos++;
      return current;
    }
    // Number literal (integer or decimal).
    const start = pos;
    if (ch === '-' || ch === '+') {
      pos++;
    }
    while (pos < expr.length && /[0-9.]/.test(expr[pos]!)) {
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
