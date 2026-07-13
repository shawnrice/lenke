import { createEmptyGraph } from '@lenke/native';
import { createFfiBackend } from '@lenke/native/ffi';
const LIB = new URL('../../../crates/lenke-core/target/release/liblenke_core.so', import.meta.url)
  .pathname;
const g = createEmptyGraph(createFfiBackend(LIB));
for (const attempt of ['INSERT (:`Order` {oid: 1})', 'INSERT (:"Order" {oid: 2})']) {
  try {
    g.query(attempt);
    console.log('OK   ', attempt);
  } catch (e: any) {
    console.log('FAIL ', attempt, '-', e.message.split(';')[0]);
  }
}
try {
  console.log('read back:', JSON.stringify(g.query('MATCH (o:`Order`) RETURN o.oid AS oid')));
} catch (e: any) {
  console.log('read FAIL', e.message.split(';')[0]);
}
g.free();
