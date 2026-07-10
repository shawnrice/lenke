import { describe, expect, test } from 'bun:test';

import { explain } from './explain.js';
import { hasLabel, out, V, values, where } from './steps.js';
import { traversal } from './traversal.js';

describe('gremlin explain', () => {
  test('renders the step sequence with arguments', () => {
    const out_ = explain(traversal(V(), hasLabel('Person'), out('KNOWS'), values('name')));

    expect(out_).toContain('V');
    expect(out_).toContain('hasLabel');
    expect(out_).toContain('Person');
    expect(out_).toContain('out');
    expect(out_).toContain('KNOWS');
    expect(out_).toContain('values');
  });

  test('indents a nested sub-traversal beneath its step', () => {
    const plan = traversal(V(), where(traversal(out('KNOWS'), hasLabel('Person'))));
    const lines = explain(plan).split('\n');

    expect(lines.some((l) => l.startsWith('where'))).toBe(true);
    // the sub-plan's steps are indented under the `where` step
    expect(lines.some((l) => /^\s{2,}plan:/.test(l) || /^\s{2,}out/.test(l))).toBe(true);
  });

  test('empty plan', () => {
    expect(explain(traversal())).toBe('(empty plan)');
  });
});
