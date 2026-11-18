import { readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expandClosure } from '../bundle/closure';
import { detectBundleExternals } from '../bundle/detection';
import { resolveExternalRoots } from '../bundle/external-roots';
import { indexTracedPackages } from '../bundle/package-utils';
import { rewrite } from '../bundle/rewrite';
import { trace } from '../bundle/trace';
import type { ExternalReason } from '../bundle/types';
import { expandGlobs } from '../utils/expand-globs';
import { sortByString } from '../utils/sort';

export interface PruneOptions {
  rewrite?: boolean;
  preserve?: string[];
  minify?: boolean;
  sourcemap?: boolean;
  verbose?: boolean;
}

function logPackagesWithReasons(packages: Set<string>, reasons: Map<string, ExternalReason[]>): void {
  for (const pkg of [...packages].toSorted(sortByString)) {
    const formatted = (reasons.get(pkg) ?? []).map((r) => (typeof r === 'string' ? r : `via ${r.reachableFrom}`)).join(', ');

    console.log(`  ${pkg}  [${formatted}]`);
  }
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

    const { classification, outDirs, nestedExternals } = await rewrite({
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

      logPackagesWithReasons(classification.external, classification.reasons);
    } else {
      console.log(`force-external: ${externalCount} packages`);
    }

    if (verbose && classification.shared.size > 0) {
      console.log(`\nshared with external packages (${classification.shared.size}):`);

      logPackagesWithReasons(classification.shared, classification.reasons);
    }

    traceEntries = entrypoints.map((e) => resolve(cwd, e));
    // nested copies are referenced by relative path from the bundle; rolldown's
    // __require helper hides those edges from NFT, so they are traced as roots too.
    externalRoots = [...resolveExternalRoots(classification.external, cwd), ...nestedExternals.map((n) => n.file)];
    forceExternal = classification.external;

    if (verbose && nestedExternals.length > 0) {
      console.log(`\nnested externals (${nestedExternals.length}):`);

      const sorted = nestedExternals.toSorted((a, b) => sortByString(a.dir, b.dir));

      for (const n of sorted) console.log(`  ${n.pkg}  ${n.dir.slice(cwd.length + 1)}`);
    }

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

  const result = await trace(allTraceInputs, cwd);

  // rewrite mode already recovered __require externals via classify. without it, scan the
  // bundled chunks here, trace their closure, and force-preserve them.
  if (!opts.rewrite) {
    const bundlePackages = detectBundleExternals(result, cwd);

    if (bundlePackages.size > 0) {
      const { external } = expandClosure(bundlePackages, new Map(), cwd, indexTracedPackages(result.fileList, cwd));
      const roots = resolveExternalRoots(external, cwd);

      if (roots.length > 0) {
        const supplemental = await trace(roots, cwd);

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
    const match = /node_modules\/(@[^/]+\/[^/]+|[^/]+)/.exec(f);

    if (match) packages.add(match[1]);
  }

  // every `node_modules/<pkg>` directory enclosing a file, outermost first
  const enclosingPackageDirs = (file: string): { pkg: string; dir: string }[] => {
    const segments = file.split('/');
    const dirs: { pkg: string; dir: string }[] = [];

    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] !== 'node_modules') continue;

      const next = segments[i + 1];

      if (!next || next.startsWith('.')) continue;

      const pkgEnd = i + (next.startsWith('@') ? 2 : 1);

      if (pkgEnd >= segments.length) continue;

      dirs.push({ pkg: segments.slice(i + 1, pkgEnd + 1).join('/'), dir: segments.slice(0, pkgEnd + 1).join('/') });
    }

    return dirs;
  };

  // force-external packages have untraceable codepaths by definition; preserve them whole.
  // a traced file inside a nested copy marks that copy as the one in use, so it is kept whole too.
  const keepRoots = new Set<string>();

  for (const pkg of forceExternal) {
    keepRoots.add(`node_modules/${pkg}`);
  }

  // node's resolver needs package.json for every enclosing package; NFT doesn't always emit it.
  const derivedPackageJsons: string[] = [];

  for (const f of tracedSet) {
    for (const { pkg, dir } of enclosingPackageDirs(f)) {
      derivedPackageJsons.push(`${dir}/package.json`);

      if (forceExternal.has(pkg)) keepRoots.add(dir);
    }
  }

  for (const p of derivedPackageJsons) tracedSet.add(p);

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
