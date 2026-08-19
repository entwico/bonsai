import { dirname, resolve } from 'node:path';
import { type Plugin, rolldown } from 'rolldown';
import { classify } from './classify';
import { expandClosure } from './closure';
import { PackageAnalyzer } from './package-analyzer';
import { packageNameFromSpecifier } from './package-utils';
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

export interface RewriteResult {
  classification: Classification;
  outDirs: string[];
}

// bare imports rolldown can't resolve are kept external instead of failing
// the build — node may still resolve them at runtime, and the prune preserves them.
function createExternalFallbackPlugin(unresolved: Set<string>): Plugin {
  return {
    name: 'bonsai-external-fallback',
    async resolveId(source, importer) {
      const pkg = packageNameFromSpecifier(source);

      if (!pkg || source.startsWith('\0')) return null;

      // eslint-disable-next-line unicorn/no-this-outside-of-class -- `this` is rolldown's plugin context
      const resolved = await this.resolve(source, importer);

      if (resolved) return resolved;

      unresolved.add(pkg);

      return { id: source, external: true };
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

  const isExternal = (id: string): boolean => {
    if (id.startsWith('.') || id.startsWith('/')) return false;
    if (id.startsWith('node:')) return true;

    const pkg = packageNameFromSpecifier(id);

    if (pkg && classification.external.has(pkg)) return true;

    return !analyzer.isSafeToBundle(id);
  };

  for (const [outDir, entries] of groups) {
    const bundle = await rolldown({
      input: entries,
      cwd: opts.cwd,
      external: (id) => isExternal(id),
      plugins: [createExternalFallbackPlugin(unresolved)],
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

  return { classification, outDirs };
}
