// Enforces that a workspace project never reaches into ANOTHER project through a
// relative import/export path. Cross-project code must travel through the target
// package's public entry — a bare `@lenke/*` specifier — so the dependency is a
// real, resolvable edge: visible to nx's project graph (so cache invalidation is
// correct) and confined to the package's declared public API (encapsulation).
//
// Allowed, never reported:
//   - in-project relative paths (`./x`, `../sibling`, `../fixtures/y.js`)
//   - bare specifiers (`@lenke/core`, `node:fs`, `bun:ffi`)
// Reported:
//   - a relative specifier that resolves OUTSIDE the importing file's own project
//     (`../../packages/other/src/x.js`, `../../crates/foo/target/bar.wasm`)
//
// This can only see *imports*. A dependency loaded by a runtime path string
// (`dlopen('…/liblenke_core.so')`, `WebAssembly.instantiate`) is invisible to any
// import-graph linter — that class is covered by the `rust-artifact-dependency`
// guard test in packages/native instead.
//
// Escape hatch (use with a reason): the target is a build artifact with no
// package entry, or a source import that deliberately avoids a build step:
//   // oxlint-disable-next-line boundaries/no-cross-package-relative-import -- <why>

import path from 'node:path';

// Top-level directories that each hold one workspace project per child dir.
const PROJECT_BUCKETS = new Set(['packages', 'examples', 'crates']);

// The project id ("packages/native") that owns an absolute path, or null when the
// path is not inside any workspace project (e.g. a repo-root file).
const projectOf = (absPath, root) => {
  const rel = path.relative(root, absPath);

  if (rel === '' || rel.startsWith('..')) {
    return null;
  }

  const [bucket, name] = rel.split(path.sep);

  if (name && PROJECT_BUCKETS.has(bucket)) {
    return `${bucket}/${name}`;
  }

  return null;
};

const rule = {
  meta: {
    type: 'problem',
    messages: {
      crossPackage:
        "Relative import '{{specifier}}' reaches into another workspace project ({{target}}). Import it through that package's public entry point (a bare `@lenke/*` specifier) so the dependency is an edge nx can resolve — a relative reach-in bypasses the package's public API and can hide from the project graph. If this is deliberate (a build artifact with no package entry, or a source import that avoids a build step), disable this line with a reason.",
    },
  },
  create(context) {
    const root = context.cwd;
    const filename = path.resolve(context.physicalFilename ?? context.filename);
    const fromProject = projectOf(filename, root);

    if (!fromProject) {
      return {};
    }

    const fromDir = path.dirname(filename);

    const check = (source) => {
      if (!source || typeof source.value !== 'string') {
        return;
      }

      const spec = source.value;

      if (!spec.startsWith('.')) {
        return;
      }

      const target = projectOf(path.resolve(fromDir, spec), root);

      if (target !== fromProject) {
        context.report({
          node: source,
          messageId: 'crossPackage',
          data: { specifier: spec, target: target ?? 'outside the workspace' },
        });
      }
    };

    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
    };
  },
};

const plugin = {
  meta: { name: 'boundaries' },
  rules: { 'no-cross-package-relative-import': rule },
};

// eslint-disable-next-line import/no-default-export -- oxlint jsPlugins API requires default export
export default plugin;
