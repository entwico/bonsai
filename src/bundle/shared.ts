import { join } from 'node:path';
import type { NodeFileTraceResult } from '@vercel/nft';
import type { PackageAnalyzer } from './package-analyzer';
import { packageDirOfFile, packageOfFile } from './package-utils';

function isPackageFile(file: string): boolean {
  return file.startsWith('node_modules/') || file.includes('/node_modules/');
}

// package-level import edges of the trace: importer → the packages its files import
function indexPackageImports(trace: NodeFileTraceResult): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();

  const add = (importer: string, pkg: string): void => {
    const imported = imports.get(importer);

    if (imported) {
      imported.add(pkg);
    } else {
      imports.set(importer, new Set([pkg]));
    }
  };

  for (const [file, reason] of trace.reasons) {
    const pkg = reason.ignored || !isPackageFile(file) ? null : packageOfFile(file);

    if (!pkg) continue;

    const importers = [...reason.parents].map((parent) => (isPackageFile(parent) ? packageOfFile(parent) : null));

    importers.filter((importer) => importer !== null && importer !== pkg).forEach((importer) => add(importer!, pkg));
  }

  return imports;
}

// traced packages rolldown leaves external on its own because they cannot be bundled as ESM
function findUnbundleablePackages(trace: NodeFileTraceResult, cwd: string, analyzer: PackageAnalyzer): Set<string> {
  const packages = new Set<string>();

  for (const file of trace.fileList) {
    const pkg = isPackageFile(file) ? packageOfFile(file) : null;
    const dir = pkg ? packageDirOfFile(join(cwd, file), pkg) : null;

    if (pkg && dir && !analyzer.isDirSafeToBundle(dir)) packages.add(pkg);
  }

  return packages;
}

// a package that stays out of the bundle loads its imports from node_modules at
// runtime. inlining one of those for the app as well would leave two live copies
// whose module-level state (a react context, a registry, a singleton) is not shared.
// so every package the trace reaches from a package that is not inlined is not
// inlined either, whatever kind of dependency edge (peer included) leads there.
//
// returns each such package mapped to the package that imports it.
export function findSharedPackages(
  trace: NodeFileTraceResult,
  cwd: string,
  external: Set<string>,
  analyzer: PackageAnalyzer,
): Map<string, string> {
  const imports = indexPackageImports(trace);
  const notInlined = new Set([...external, ...findUnbundleablePackages(trace, cwd, analyzer)]);
  const shared = new Map<string, string>();
  const queue = [...notInlined];

  while (queue.length > 0) {
    const importer = queue.shift()!;
    const reached = [...(imports.get(importer) ?? [])].filter((pkg) => !notInlined.has(pkg));

    for (const pkg of reached) {
      notInlined.add(pkg);
      shared.set(pkg, importer);
      queue.push(pkg);
    }
  }

  return shared;
}
