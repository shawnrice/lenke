import { tsDeserialize, Graph, tsQuery } from './harness.ts';
const show = (label: string, inp: string) => {
  const g = tsDeserialize(inp, 'csv', new Graph());
  console.log(label, JSON.stringify(tsQuery(g, 'MATCH (n) RETURN n')));
};
show('no-NL   ', ':ID,:LABEL,name\n1,A,hello');
show('trailNL ', ':ID,:LABEL,name\n1,A,hello\n');
show('CRLF    ', ':ID,:LABEL,name\r\n1,A,hello\r\n');
show('2cols   ', ':ID,:LABEL,name,city\n1,A,hello,NYC');
show('2cols-NL', ':ID,:LABEL,name,city\n1,A,hello,NYC\n');
show('typed   ', ':ID,:LABEL,age:int\n1,A,5');
show('typed-NL', ':ID,:LABEL,age:int\n1,A,5\n');
