import { runBoth, nativeGraph, tsGraph, tsQuery } from './harness.ts';
console.log('smoke1', JSON.stringify(runBoth(`MATCH (n:Person) RETURN n.name ORDER BY n.name`)));
console.log('smoke2', JSON.stringify(runBoth(`RETURN 1+1 AS x`)));
