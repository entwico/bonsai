import { expandClosure } from './closure';
import { detectExternals } from './detection';
import { PackageAnalyzer } from './package-analyzer';
import { indexTracedPackages } from './package-utils';
import { findSharedPackages } from './shared';
import { trace } from './trace';
import type { Classification } from './types';

export async function classify(
  entrypoints: string[],
  cwd: string,
  analyzer: PackageAnalyzer = new PackageAnalyzer(cwd),
): Promise<Classification> {
  const traced = await trace(entrypoints, cwd);
  const packageDirs = indexTracedPackages(traced.fileList, cwd);
  const detection = detectExternals(traced, cwd);
  const { external, reasons } = expandClosure(detection.packages, detection.reasons, cwd, packageDirs);
  const shared = new Set<string>();

  for (const [pkg, importer] of findSharedPackages(traced, cwd, external, analyzer)) {
    shared.add(pkg);
    reasons.set(pkg, [{ reachableFrom: importer }]);
  }

  return { external, shared, reasons };
}
