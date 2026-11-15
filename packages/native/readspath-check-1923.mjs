import { traversal } from '@lenke/gremlin';
import {
  V,
  as_,
  neq,
  out,
  select,
  simplePath,
  where,
  cyclicPath,
  path,
  values,
} from '@lenke/gremlin';

const show = (name, plan) =>
  console.log(
    `${name.padEnd(44)} readsPath=${String(plan.readsPath)}  steps=${plan.steps.map((s) => s.kind).join(',')}`,
  );

show('V().out(E).simplePath()', traversal(V(), out('E'), simplePath()));
show('V().out(E).cyclicPath()', traversal(V(), out('E'), cyclicPath()));
show('V().as_(x).out(E).where(neq(x))', traversal(V(), as_('x'), out('E'), where(neq('x'))));
show('V().as_(x).out(E)', traversal(V(), as_('x'), out('E')));
show('V().out(E).path()', traversal(V(), out('E'), path()));
show('V().out(E).values(n)', traversal(V(), out('E'), values('n')));

show('V().as_(x).out(E).select(x)', traversal(V(), as_('x'), out('E'), select('x')));
show(
  'V().as_(x).out(E).where(neq(x)).values(n)',
  traversal(V(), as_('x'), out('E'), where(neq('x')), values('n')),
);
show('V().out(E).simplePath().values(n)', traversal(V(), out('E'), simplePath(), values('n')));
