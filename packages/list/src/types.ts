import type { UnaryFn } from '@lenke/fp';

import type { List } from './List.js';

export type ListFn<T, R = T> = UnaryFn<List<T>, List<R>>;
