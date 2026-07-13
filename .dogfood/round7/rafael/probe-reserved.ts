import { Graph, LocalDate } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.addVertex({
  labels: ['Transaction'],
  properties: { ref: 'T1', date: new LocalDate(2026, 1, 15) },
});

function test(label: string, q: string) {
  try {
    console.log(label, '=>', JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(label, 'THREW:', e.code ?? e.message);
  }
}

test('bare t.date', "MATCH (t:Transaction) WHERE t.date >= DATE '2026-01-01' RETURN t.ref AS ref");
test(
  'backtick t.`date`',
  "MATCH (t:Transaction) WHERE t.`date` >= DATE '2026-01-01' RETURN t.ref AS ref",
);
test('RETURN t.date bare', 'MATCH (t:Transaction) RETURN t.date AS d');
test('RETURN t.`date`', 'MATCH (t:Transaction) RETURN t.`date` AS d');
