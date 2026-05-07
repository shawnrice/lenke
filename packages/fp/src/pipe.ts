import type { UnaryFn } from './types.js';
import { isIterable, maybeOptimizeIterable } from './utils.js';

// Explicit-input form: `pipe<Input>()(fn0, fn1, ...)`.
// Use when the chain starts with a generic combinator (skip, take) that has
// no upstream type to infer from. The Input type anchors the chain; Output
// is inferred from the last link.
export function pipe<I>(): {
  <A, O>(x0: UnaryFn<I, A>, x1: UnaryFn<A, O>): UnaryFn<I, O>;
  <A, B, O>(x0: UnaryFn<I, A>, x1: UnaryFn<A, B>, x2: UnaryFn<B, O>): UnaryFn<I, O>;
  <A, B, C, O>(
    x0: UnaryFn<I, A>,
    x1: UnaryFn<A, B>,
    x2: UnaryFn<B, C>,
    x3: UnaryFn<C, O>,
  ): UnaryFn<I, O>;
  <A, B, C, D, O>(
    x0: UnaryFn<I, A>,
    x1: UnaryFn<A, B>,
    x2: UnaryFn<B, C>,
    x3: UnaryFn<C, D>,
    x4: UnaryFn<D, O>,
  ): UnaryFn<I, O>;
};

export function pipe<A, B>(x0: UnaryFn<A, B>): UnaryFn<A, B>;
export function pipe<A, B, C>(x0: UnaryFn<A, B>, x1: UnaryFn<B, C>): UnaryFn<A, C>;
export function pipe<A, B, C, D>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
): UnaryFn<A, D>;
export function pipe<A, B, C, D, E>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
): UnaryFn<A, E>;
export function pipe<A, B, C, D, E, F>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
): UnaryFn<A, F>;
export function pipe<A, B, C, D, E, F, G>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
): UnaryFn<A, G>;
export function pipe<A, B, C, D, E, F, G, H>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
): UnaryFn<A, H>;
export function pipe<A, B, C, D, E, F, G, H, I>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
): UnaryFn<A, I>;
export function pipe<A, B, C, D, E, F, G, H, I, J>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
): UnaryFn<A, J>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
): UnaryFn<A, K>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
): UnaryFn<A, L>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
): UnaryFn<A, M>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
): UnaryFn<A, N>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
): UnaryFn<A, O>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
): UnaryFn<A, P>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
  x15: UnaryFn<P, Q>,
): UnaryFn<A, Q>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
  x15: UnaryFn<P, Q>,
  x16: UnaryFn<Q, R>,
): UnaryFn<A, R>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
  x15: UnaryFn<P, Q>,
  x16: UnaryFn<Q, R>,
  x17: UnaryFn<R, S>,
): UnaryFn<A, S>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
  x15: UnaryFn<P, Q>,
  x16: UnaryFn<Q, R>,
  x17: UnaryFn<R, S>,
  x18: UnaryFn<S, T>,
): UnaryFn<A, T>;
export function pipe<A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U>(
  x0: UnaryFn<A, B>,
  x1: UnaryFn<B, C>,
  x2: UnaryFn<C, D>,
  x3: UnaryFn<D, E>,
  x4: UnaryFn<E, F>,
  x5: UnaryFn<F, G>,
  x6: UnaryFn<G, H>,
  x7: UnaryFn<H, I>,
  x8: UnaryFn<I, J>,
  x9: UnaryFn<J, K>,
  x10: UnaryFn<K, L>,
  x11: UnaryFn<L, M>,
  x12: UnaryFn<M, N>,
  x13: UnaryFn<N, O>,
  x14: UnaryFn<O, P>,
  x15: UnaryFn<P, Q>,
  x16: UnaryFn<Q, R>,
  x17: UnaryFn<R, S>,
  x18: UnaryFn<S, T>,
  x19: UnaryFn<T, U>,
): UnaryFn<A, U>;

export function pipe(...fns: ReadonlyArray<(value: any) => any>): any {
  if (fns.length === 0) {
    return (...curried: ReadonlyArray<(value: any) => any>) => compose(curried);
  }
  return compose(fns);
}

const compose =
  (fns: ReadonlyArray<(value: any) => any>) =>
  (x0: unknown): unknown =>
    fns.reduce<unknown>((g, f) => f(g), isIterable(x0) ? maybeOptimizeIterable(x0) : x0);
