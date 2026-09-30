import { realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, resolve } from 'node:path';
import { type Plugin, rolldown } from 'rolldown';
import { classify } from './classify';
import { expandClosure } from './closure';
import { PackageAnalyzer } from './package-analyzer';
import { findPackageDir, packageDirOfFile, packageNameFromSpecifier } from './package-utils';
import type { Classification, DetectReason } from './types';

export interface RewriteOptions {
  entrypoints: string[];
  cwd: string;
  /** single output directory for all entries; default is each entry's own directory. */
  outDir?: string | undefined;
  /** default true. set false for un-minified output (debugging only — bundling already breaks stack traces). */
  minify?: boolean | undefined;
  /** default true. set false to skip emitting `.mjs.map` files. */
  sourcemap?: boolean | undefined;
}

/** an external whose importer resolves to a different copy than the output directory would. */
export interface NestedExternal {
  pkg: string;
  /** absolute directory of the copy the importer resolves to */
  dir: string;
  /** absolute file the import resolved to; the bundle references it by relative path */
  file: string;
}

export interface RewriteResult {
  classification: Classification;
  outDirs: string[];
  nestedExternals: NestedExternal[];
}

interface ExternalsPluginOptions {
  classification: Classification;
  analyzer: PackageAnalyzer;
  outDir: string;
  unresolved: Set<string>;
  nested: NestedExternal[];
}

function samePackageDir(a: string, b: string | null): boolean {
  if (!b) return false;

  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// decides per import edge whether a bare specifier stays external. an external
// keeps its bare specifier only when the output directory resolves it to the same
// copy the importer did — a nested copy (a second version under the importer's
// `node_modules`) is referenced by relative path instead, since node would
// otherwise load the hoisted version from the bundle's location.
//
// bare imports rolldown can't resolve are kept external instead of failing
// the build — node may still resolve them at runtime, and the prune preserves them.
function createExternalsPlugin(opts: ExternalsPluginOptions): Plugin {
  const outDirCopies = new Map<string, string | null>();

  const outDirResolves = (pkg: string): string | null => {
    let dir = outDirCopies.get(pkg);

    if (dir === undefined) {
      dir = findPackageDir(pkg, opts.outDir);
      outDirCopies.set(pkg, dir);
    }

    return dir;
  };

  return {
    name: 'bonsai-externals',
    async resolveId(source, importer, options) {
      if (source.startsWith('\0')) return null;
      if (isBuiltin(source)) return { id: source, external: true };

      const pkg = packageNameFromSpecifier(source);

      if (!pkg) return null;

      // eslint-disable-next-line unicorn/no-this-outside-of-class -- `this` is rolldown's plugin context
      const resolved = await this.resolve(source, importer, { kind: options.kind });

      if (!resolved) {
        opts.unresolved.add(pkg);

        return { id: source, external: true };
      }

      if (resolved.external) return resolved;

      const external = opts.classification.external.has(pkg) || !opts.analyzer.isSafeToBundle(source, importer);

      if (!external) return resolved;

      const dir = packageDirOfFile(resolved.id, pkg);

      if (!dir || samePackageDir(dir, outDirResolves(pkg))) return { id: source, external: true };

      opts.nested.push({ pkg, dir, file: resolved.id });

      return { id: resolved.id, external: 'relative' };
    },
  };
}

export async function rewrite(opts: RewriteOptions): Promise<RewriteResult> {
  // rolldown resolves a file's internal relative imports against its own
  // location only when the input path is absolute. relative inputs cause
  // `./chunks/foo.mjs` to be looked up under cwd instead.
  const absoluteEntries = opts.entrypoints.map((e) => resolve(opts.cwd, e));
  const classification = await classify(absoluteEntries, opts.cwd);
  const analyzer = new PackageAnalyzer(opts.cwd);
  const unresolved = new Set<string>();
  const nestedExternals: NestedExternal[] = [];

  // each entry is rewritten next to itself so runtime references to its original
  // path stay valid; entries sharing a directory share one build and its chunks.
  const groups = new Map<string, string[]>();
  const outDirs: string[] = [];

  for (const entry of absoluteEntries) {
    const outDir = opts.outDir ? resolve(opts.cwd, opts.outDir) : dirname(entry);
    const group = groups.get(outDir);

    if (group) {
      group.push(entry);
    } else {
      groups.set(outDir, [entry]);
      outDirs.push(outDir);
    }
  }

  for (const [outDir, entries] of groups) {
    const bundle = await rolldown({
      input: entries,
      cwd: opts.cwd,
      plugins: [createExternalsPlugin({ classification, analyzer, outDir, unresolved, nested: nestedExternals })],
      platform: 'node',
      transform: {
        define: { 'process.env.NODE_ENV': '"production"' },
      },
    });

    await bundle.write({
      dir: outDir,
      format: 'esm',
      entryFileNames: '[name].mjs',
      chunkFileNames: 'chunks/[name]-[hash].mjs',
      sourcemap: opts.sourcemap !== false,
      minify:
        opts.minify === false
          ? false
          : {
              mangle: { keepNames: { function: true, class: true } },
              compress: { keepNames: { function: true, class: true } },
            },
    });

    await bundle.close();
  }

  if (unresolved.size > 0) {
    const detectedReasons = new Map<string, DetectReason[]>();

    for (const pkg of unresolved) detectedReasons.set(pkg, ['unresolved-import']);

    const closure = expandClosure(unresolved, detectedReasons, opts.cwd);

    for (const pkg of closure.external) {
      classification.external.add(pkg);

      if (!classification.reasons.has(pkg)) {
        classification.reasons.set(pkg, closure.reasons.get(pkg) ?? []);
      }
    }
  }

  return { classification, outDirs, nestedExternals };
}
