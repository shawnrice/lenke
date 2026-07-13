import { createEmptyGraph } from '@lenke/native';
// Which common domain labels collide with GQL reserved words on INSERT?
import { createFfiBackend } from '@lenke/native/ffi';

const LIB = new URL('../../../crates/lenke-core/target/release/liblenke_core.so', import.meta.url)
  .pathname;
const g = createEmptyGraph(createFfiBackend(LIB));
for (const label of [
  'Product',
  'Order',
  'Item',
  'Purchase',
  'Customer',
  'User',
  'Group',
  'Value',
  'Count',
  'Sum',
  'Status',
  'Category',
  'Node',
  'Edge',
  'Match',
  'Return',
]) {
  try {
    g.query(`INSERT (:${label} {x: 1})`);
    console.log('OK    ', label);
  } catch (e: any) {
    console.log('RESVD ', label, '-', e.message.split(';')[0].replace('lenke: query: ', ''));
  }
}
g.free();
