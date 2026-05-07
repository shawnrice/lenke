import { boundary } from './boundary.js';

export const toArray = boundary(<T>(iterable: Iterable<T>): T[] => Array.from(iterable));
