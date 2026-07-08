// Flags a value spliced into GQL / Gremlin query TEXT — an injection risk.
//
// The lenke query APIs are safe two ways:
//   - a TAGGED TEMPLATE — ``g.query`… ${x}` `` (GQL binds the interpolation as a
//     $param; Gremlin escapes it into a safe literal). These are
//     TaggedTemplateExpression nodes, never CallExpression, so this rule never
//     touches them.
//   - a `$name` param bag — `g.query('… WHERE x = $x', { x })`.
//
// The UNSAFE path is a plain call whose query-text argument is built at runtime
// by concatenation (`'MATCH …' + userInput`) or by an interpolated template
// passed as an ordinary argument (`g.query(`… ${userInput}`)` — note: NOT a tag,
// so the interpolation is string-spliced, not bound). Same method, safe-as-tag
// vs unsafe-as-plain-call — this rule makes the unsafe shape loud and greppable.
//
// It is intentionally SYNTACTIC (keys on the callee's method name, not its type),
// so it flags on the shape alone. An inline concat/interpolation in the text
// position is the smell; a bare variable is NOT flagged (a trusted prepared
// query can't be told from an unsafe one syntactically). If the text is fully
// trusted (e.g. assembled from constants), suppress the line with a disable
// comment stating why.

// Method calls whose FIRST argument is query text.
const METHODS = new Set([
  'query',
  'queryArrow',
  'gremlin',
  'mutate',
  'mutateGremlin',
  'liveQuery',
  'liveGremlin',
]);

/** Which argument holds the query text for this call, or -1 if not a query call. */
const textArgIndex = (node) => {
  const { callee } = node;

  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    METHODS.has(callee.property.name)
  ) {
    return 0;
  }

  // The `@lenke/gql` free function: query(graph, text, params) — text is arg 1.
  if (callee.type === 'Identifier' && callee.name === 'query') {
    return 1;
  }

  return -1;
};

/** The unsafe shapes: `+` concatenation, or an interpolated template as a plain arg. */
const rawShape = (arg) => {
  if (!arg) {
    return null;
  }

  if (arg.type === 'TemplateLiteral' && arg.expressions.length > 0) {
    return 'an interpolated template passed as a plain argument';
  }

  if (arg.type === 'BinaryExpression' && arg.operator === '+') {
    return 'string concatenation';
  }

  return null;
};

/** The ESLint/oxlint rule object (shared verbatim by both linters). */
export const noRawInterpolation = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow interpolating a value into GQL / Gremlin query text (injection risk).',
    },
    messages: {
      rawInterpolation:
        'A value is spliced into {{fn}} query text via {{how}} — an injection risk. ' +
        'Use a tagged template (interpolations in a tag are bound for GQL / escaped for Gremlin) ' +
        'or a `$name` param. If the text is fully trusted, suppress this line with a disable ' +
        'comment saying why.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const i = textArgIndex(node);

        if (i < 0) {
          return;
        }

        const how = rawShape(node.arguments[i]);

        if (how === null) {
          return;
        }

        const { callee } = node;
        const fn =
          callee.type === 'MemberExpression' ? `.${callee.property.name}()` : `${callee.name}()`;

        context.report({
          node: node.arguments[i],
          messageId: 'rawInterpolation',
          data: { fn, how },
        });
      },
    };
  },
};
