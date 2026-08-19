import { readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nodeFileTrace } from '@vercel/nft';
import { expandClosure } from '../bundle/closure';
import { detectBundleExternals } from '../bundle/detection';
import { resolveExternalRoots } from '../bundle/external-roots';
import { indexTracedPackages } from '../bundle/package-utils';
import { rewrite } from '../bundle/rewrite';
import { expandGlobs } from '../utils/expand-globs';
import { sortByString } from '../utils/sort';

export interface PruneOptions {
  rewrite?: boolean;
  preserve?: string[];
  minify?: boolean;
  sourcemap?: boolean;
  verbose?: boolean;
}

export async function prune(entrypoints: string[], opts: PruneOptions = {}) {
  if (entrypoints.length === 0) {
    throw new Error('usage: bonsai prune <entrypoint>...');
  }

  const verbose = opts.verbose ?? false;
  const cwd = process.cwd();
  let traceEntries = entrypoints;
  let externalRoots: string[] = [];
  let forceExternal = new Set<string>();

  if (opts.rewrite) {
    if (verbose) {
      console.log('rewriting entrypoints:', entrypoints.join(', '));
    } else {
      const label = entrypoints.length === 1 ? 'entry' : 'entries';

      console.log(`rewriting ${entrypoints.length} ${label} in place`);
    }

    const { classification, outDirs } = await rewrite({
      entrypoints,
      cwd,
      minify: opts.minify,
      sourcemap: opts.sourcemap,
    });

    if (verbose) {
      console.log('output dirs:          ', outDirs.join(', '));
    }

    const externalCount = classification.external.size;

    if (verbose) {
      console.log(`\nforce-external packages (${externalCount}):`);

      for (const pkg of [...classification.external].toSorted(sortByString)) {
        const rs = classification.reasons.get(pkg) ?? [];
        const formatted = rs.map((r) => (typeof r === 'string' ? r : `via ${r.reachableFrom}`)).join(', ');

        console.log(`  ${pkg}  [${formatted}]`);
      }
    } else {
      console.log(`force-external: ${externalCount} packages`);
    }

    traceEntries = entrypoints.map((e) => resolve(cwd, e));
    externalRoots = resolveExternalRoots(classification.external, cwd);
    forceExternal = classification.external;

    if (verbose && externalRoots.length > 0) {
      const label = externalRoots.length === 1 ? 'root' : 'roots';

      console.log(`adding ${externalRoots.length} external package ${label} to NFT trace`);
    }

    if (verbose) console.log('');
  }

  const preserved = await expandGlobs(opts.preserve ?? [], cwd);

  if (preserved.length > 0) {
    const label = preserved.length === 1 ? 'file' : 'files';

    console.log(`preserving ${preserved.length} additional ${label} via --preserve`);
  }

  const allTraceInputs = [...traceEntries, ...externalRoots, ...preserved];

  if (verbose) {
    console.log('tracing entrypoints:', traceEntries.join(', '));
  }

  const result = await nodeFileTrace(allTraceInputs, { base: cwd });

  // rewrite mode already recovered __require externals via classify. without it, scan the
  // bundled chunks here, trace their closure, and force-preserve them.
  if (!opts.rewrite) {
    const bundlePackages = detectBundleExternals(result, cwd);

    if (bundlePackages.size > 0) {
      const { external } = expandClosure(bundlePackages, new Map(), cwd, indexTracedPackages(result.fileList, cwd));
      const roots = resolveExternalRoots(external, cwd);

      if (roots.length > 0) {
        const supplemental = await nodeFileTrace(roots, { base: cwd });

        for (const f of supplemental.fileList) result.fileList.add(f);
        for (const w of supplemental.warnings) result.warnings.add(w);
      }

      for (const pkg of external) forceExternal.add(pkg);

      const label = external.size === 1 ? 'external' : 'externals';

      console.log(`recovered ${external.size} bundled __require ${label}`);

      if (verbose) {
        for (const pkg of [...external].toSorted(sortByString)) console.log(`  ${pkg}`);
      }
    }
  }

  const tracedSet = new Set(
    [...result.fileList].filter((f) => f.startsWith('node_modules/') || f.includes('/node_modules/')),
  );

  const packages = new Set<string>();

  for (const f of tracedSet) {
    const match = f.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);

    if (match) packages.add(match[1]);
  }

  // node's resolver needs package.json for every enclosing package; NFT doesn't always emit it.
  const enclosingPackageJsons = (file: string): string[] => {
    const segments = file.split('/');
    const paths: string[] = [];

    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] !== 'node_modules') continue;

      const next = segments[i + 1];

      if (!next || next.startsWith('.')) continue;

      const pkgEnd = i + (next.startsWith('@') ? 2 : 1);

      if (pkgEnd >= segments.length) continue;

      paths.push(`${segments.slice(0, pkgEnd + 1).join('/')}/package.json`);
    }

    return paths;
  };

  const derivedPackageJsons: string[] = [];

  for (const f of tracedSet) derivedPackageJsons.push(...enclosingPackageJsons(f));
  for (const p of derivedPackageJsons) tracedSet.add(p);

  // force-external packages have untraceable codepaths by definition; preserve them whole.
  const keepRoots = new Set<string>();

  for (const pkg of forceExternal) {
    keepRoots.add(`node_modules/${pkg}`);
  }

  const warningCount = result.warnings.size;

  if (verbose) {
    console.log('traced packages:', packages.size);
    console.log('traced files:', tracedSet.size);
    if (warningCount > 0) console.log('NFT warnings:', warningCount);

    console.log('\npackages:');
    [...packages].toSorted(sortByString).forEach((p) => console.log(' ', p));

    console.log('\npruning non-traced files...');
  } else {
    const warnSuffix = warningCount > 0 ? `, ${warningCount} NFT warnings` : '';

    console.log(`traced ${packages.size} packages, ${tracedSet.size} files${warnSuffix}`);
  }

  const start = performance.now();
  let deleted = 0;
  const nmPath = join(cwd, 'node_modules');

  function isInsideKeepRoot(relativePath: string): boolean {
    for (const root of keepRoots) {
      if (relativePath === root || relativePath.startsWith(`${root}/`)) return true;
    }

    return false;
  }

  async function walkAndPrune(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true });

    const results = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        const relativePath = fullPath.slice(cwd.length + 1);

        if (entry.isDirectory()) {
          if (keepRoots.has(relativePath)) return false;

          const empty = await walkAndPrune(fullPath);

          if (empty) {
            await rmdir(fullPath);

            return true;
          }

          return false;
        }

        if (isInsideKeepRoot(relativePath)) return false;

        if (!tracedSet.has(relativePath)) {
          await unlink(fullPath);

          deleted++;

          return true;
        }

        return false;
      }),
    );

    return results.every(Boolean);
  }

  await walkAndPrune(nmPath);

  // wipe @types/* packages, isn't always reliably traced (e.g. protobuf)
  const typesDir = join(nmPath, '@types');
  let typesDeleted = 0;

  try {
    const typesEntries = await readdir(typesDir);

    typesDeleted = typesEntries.length;

    await rm(typesDir, { recursive: true, force: true });
  } catch {
    // no @types dir — fine.
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  const parts = [`${deleted} files`];

  if (typesDeleted > 0) parts.push(`${typesDeleted} @types ${typesDeleted === 1 ? 'package' : 'packages'}`);

  console.log(`deleted ${parts.join(', ')} in ${elapsed}s`);
}
