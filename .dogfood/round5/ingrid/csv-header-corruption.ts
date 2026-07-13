// Does a nodes CSV missing the :LABEL column silently corrupt? The decoder keys
// fixed columns BY POSITION (0=id, 1=:LABEL, 2..=props) and never validates the
// header names. So a header that omits :LABEL shifts everything left.
import { Graph } from '@lenke/core';
import { decodeNodes } from '@lenke/serialization';

const g = new Graph();
// Author intended: id + a 'name' property. But forgot the :LABEL column.
decodeNodes('id,name:string\nv,"Alice"', g);
const v = g.getVertexById('v');
console.log('vertex found:', !!v);
console.log('labels:', v ? [...v.labels] : null, '  <-- "Alice" swallowed as a LABEL');
console.log('properties:', v ? v.properties : null, '  <-- name property LOST');
