import { Graph, LocalDate, LocalDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';
import { serialize, deserialize, graphContentEqual, FORMATS } from '@lenke/serialization';
const g = new Graph();
const v = g.addVertex({ id: 'a', labels: ['P'], properties: { name: 'Al' } });
console.log('FORMATS', FORMATS);
console.log('vertex', v.id);
console.log('query typeof', typeof query);
console.log('has createUniqueConstraint', typeof (g as any).createUniqueConstraint);
