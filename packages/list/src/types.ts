import type { UnaryFn } from '@pl-graph/fp';
import { List } from './List';

export type ListFn<T, R = T> = UnaryFn<List<T>, List<R>>;
