import { readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
    .map((entry) => join('src', entry.parentPath.slice(srcDir.length).replace(/^\//, ''), entry.name));
};

const getExternals = (packageRoot: string) => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ];
};

const buildEsm = async (options: BuildOptions) => {
  const { packageRoot, entrypoints, minify = false, sourcemap = 'linked', clean = true } = options;

  const outPath = join(packageRoot, 'dist', `esm${minify ? '.min' : ''}`);
  if (clean) {
    await rm(outPath, { recursive: true, force: true });
  }

  await Bun.build({
    entrypoints: entrypoints.map((entry) => join(packageRoot, entry)),
    root: join(packageRoot, 'src'),
    external: getExternals(packageRoot),
    sourcemap,
    minify,
    splitting: entrypoints.length > 1,
    target: 'node',
    outdir: outPath,
    format: 'esm',
    naming: {
      entry: '[dir]/[name].mjs',
      chunk: '[name]-[hash].[ext]',
      asset: '[name]-[hash].[ext]',
    },
  });
};

const buildCjs = async (options: BuildOptions) => {
  const { packageRoot, entrypoints, minify = false, sourcemap = 'linked', clean = true } = options;

  const outPath = join(packageRoot, 'dist', `cjs${minify ? '.min' : ''}`);
  if (clean) {
    await rm(outPath, { recursive: true, force: true });
  }

  await Bun.build({
    entrypoints: entrypoints.map((entry) => join(packageRoot, entry)),
    root: join(packageRoot, 'src'),
    external: getExternals(packageRoot),
    sourcemap,
    minify,
    target: 'node',
    format: 'cjs',
    outdir: outPath,
  });
};

type TypescriptBuildOptions = {
  packageRoot: string;
  configFile: string;
};

const runTsc = ({ packageRoot, configFile }: TypescriptBuildOptions): Promise<void> => {
  return new Promise((resolve, reject) => {
    const config = ts.readConfigFile(join(packageRoot, configFile), ts.sys.readFile);
    if (config.error) {
      reject(new Error(`Error reading tsconfig: ${config.error.messageText}`));
      return;
    }

    const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);

    if (parsedConfig.errors.length) {
      reject(new Error(`Error parsing tsconfig: ${parsedConfig.errors[0].messageText}`));
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
        getCurrentDirectory: ts.sys.getCurrentDirectory,
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
    ? await collectSourceEntrypoints(packageRoot)
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
