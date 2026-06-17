// Deterministic NDJSON generator shared by both engines. All nodes are
// :Person with scalar props (name/age/active); edges are :KNOWS between random
// persons. age = i % 100 so `age > 50` selects a predictable ~49%.

export type Dataset = { ndjson: string; nVertices: number; nEdges: number };

export const genNdjson = (nVertices: number, avgDegree: number, seed = 0x1234_5678): Dataset => {
  let s = seed >>> 0;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;

    return s >>> 0;
  };
  const nEdges = nVertices * avgDegree;
  const lines: string[] = new Array(nVertices + nEdges);

  for (let i = 0; i < nVertices; i++) {
    lines[i] = JSON.stringify({
      type: 'node',
      id: `n${i}`,
      labels: ['Person'],
      // dept is low-cardinality (10 values) so GROUP BY / DISTINCT are meaningful.
      properties: { name: `p${i}`, age: i % 100, active: i % 2 === 0, dept: `d${i % 10}` },
    });
  }

  for (let i = 0; i < nEdges; i++) {
    const a = rnd() % nVertices;
    const b = rnd() % nVertices;
    lines[nVertices + i] = JSON.stringify({
      type: 'edge',
      id: `e${i}`,
      from: `n${a}`,
      to: `n${b}`,
      labels: ['KNOWS'],
      properties: {},
    });
  }

  return { ndjson: lines.join('\n'), nVertices, nEdges };
};
