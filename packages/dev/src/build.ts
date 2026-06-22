import { readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { rolldown } from 'rolldown';
import ts from 'typescript';

export type BuildOptions = {
  packageRoot: string;
  entrypoints: string[];
  minify?: boolean;
  sourcemap?: 'inline' | 'external' | 'linked' | false;
  clean?: boolean;
};

export type PackageConfig = {
  packageRoot?: string;
  additionalEntrypoints?: string[];
  skipTypes?: boolean;
  skipEsm?: boolean;
  skipCjs?: boolean;
  skipMin?: boolean;
  perFile?: boolean;
  typesConfigPath?: string;
};

const collectSourceEntrypoints = (packageRoot: string): string[] => {
  const srcDir = join(packageRoot, 'src');

  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts'),
    )
    .map((entry) =>
      join('src', entry.parentPath.slice(srcDir.length).replace(/^\//, ''), entry.name),
    );
};

// A bare specifier (not relative, not absolute) is a dependency or a runtime
// builtin (`node:*`, `bun:*`, `react`, `@pl-graph/*`, …) — external it so a
// library build bundles only the package's own source. (`getExternals` is the
// declared subset of these; matching every bare specifier also covers builtins,
// which is exactly what a library wants externalized.)
const isBareSpecifier = (id: string): boolean =>
  !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0');

// Map each entrypoint to an output name relative to `src/` (sans extension), so
// `src/TreeNode/index.ts` → `dist/<fmt>/TreeNode/index.<ext>` — preserving the
// source layout the way the previous Bun `[dir]/[name]` naming did.
const toInput = (packageRoot: string, entrypoints: string[]): Record<string, string> => {
  const srcDir = join(packageRoot, 'src');
  const input: Record<string, string> = {};

  for (const entry of entrypoints) {
    const abs = join(packageRoot, entry);
    input[relative(srcDir, abs).replace(/\.tsx?$/, '')] = abs;
  }

  return input;
};

const toRolldownSourcemap = (sourcemap: BuildOptions['sourcemap']): boolean | 'inline' => {
  if (sourcemap === false) {
    return false;
  }

  if (sourcemap === 'inline') {
    return 'inline';
  }

  // 'linked' / 'external' → an external `.map` with a sourceMappingURL comment.
  return true;
};

// We bundle with rolldown (Rollup semantics) rather than `Bun.build`: a library
// entry's exported implementations must survive, and rolldown preserves them.
// `Bun.build` instead tree-shakes the re-exported bodies out of the library's
// *own* output when the package is `sideEffects: false`, shipping a bodyless
// `export { … }` — which is why every barrel package needs this bundler to ship
// `sideEffects: false` (the flag consumers rely on to tree-shake).
const bundleWith = async (
  options: BuildOptions,
  format: 'es' | 'cjs',
  ext: 'mjs' | 'cjs',
): Promise<void> => {
  const { packageRoot, entrypoints, minify = false, sourcemap = 'linked', clean = true } = options;
  const outPath = join(
    packageRoot,
    'dist',
    `${format === 'es' ? 'esm' : 'cjs'}${minify ? '.min' : ''}`,
  );

  if (clean) {
    await rm(outPath, { recursive: true, force: true });
  }

  const bundle = await rolldown({
    input: toInput(packageRoot, entrypoints),
    platform: 'node',
    external: isBareSpecifier,
    // Source uses NodeNext `.js` specifiers that point at `.ts`/`.tsx` files.
    resolve: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  });

  await bundle.write({
    dir: outPath,
    format,
    sourcemap: toRolldownSourcemap(sourcemap),
    minify,
    entryFileNames: `[name].${ext}`,
    chunkFileNames: `[name]-[hash].${ext === 'mjs' ? 'js' : 'cjs'}`,
  });

  await bundle.close();
};

const buildEsm = (options: BuildOptions): Promise<void> => bundleWith(options, 'es', 'mjs');

const buildCjs = (options: BuildOptions): Promise<void> => bundleWith(options, 'cjs', 'cjs');

type TypescriptBuildOptions = {
  packageRoot: string;
  configFile: string;
};

const runTsc = ({ packageRoot, configFile }: TypescriptBuildOptions): Promise<void> => {
  return new Promise((resolve, reject) => {
    const config = ts.readConfigFile(join(packageRoot, configFile), (fileName) =>
      ts.sys.readFile(fileName),
    );

    if (config.error) {
      reject(
        new Error(
          `Error reading tsconfig: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}`,
        ),
      );

      return;
    }

    const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);

    if (parsedConfig.errors.length) {
      reject(
        new Error(
          `Error parsing tsconfig: ${ts.flattenDiagnosticMessageText(parsedConfig.errors[0].messageText, '\n')}`,
        ),
      );

      return;
    }

    const program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
    });

    const emitResult = program.emit();

    const allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

    if (allDiagnostics.length > 0) {
      const formatHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getNewLine: () => ts.sys.newLine,
      };

      const diagnosticsText = ts.formatDiagnostics(allDiagnostics, formatHost);

      if (emitResult.emitSkipped) {
        reject(new Error(`TypeScript compilation failed:\n${diagnosticsText}`));

        return;
      }

      console.warn(diagnosticsText);
    }

    resolve();
  });
};

export const buildPackage = async (config: PackageConfig = {}) => {
  const {
    packageRoot = process.cwd(),
    additionalEntrypoints = [],
    skipTypes = false,
    skipEsm = false,
    skipCjs = false,
    skipMin = false,
    perFile = false,
    typesConfigPath = 'tsconfig.types.json',
  } = config;

  const entrypoints = perFile
    ? collectSourceEntrypoints(packageRoot)
    : ['src/index.ts', ...additionalEntrypoints];
  const tasks: Promise<void>[] = [];

  if (!skipEsm) {
    tasks.push(buildEsm({ packageRoot, entrypoints }));

    if (!skipMin) {
      tasks.push(buildEsm({ packageRoot, entrypoints, minify: true }));
    }
  }

  if (!skipTypes) {
    tasks.push(runTsc({ packageRoot, configFile: typesConfigPath }));
  }

  if (!skipCjs) {
    tasks.push(buildCjs({ packageRoot, entrypoints }));

    if (!skipMin) {
      tasks.push(buildCjs({ packageRoot, entrypoints, minify: true }));
    }
  }

  return Promise.all(tasks).catch((error) => {
    console.error('Build failed:', error);
    process.exit(1);
  });
};
