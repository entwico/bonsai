import { readPackageJson } from './package-utils';
import type { DetectReason, ExternalReason } from './types';

// follows the declared `dependencies` / `optionalDependencies` of the detected packages:
// those have codepaths the trace cannot see, so their declared deps are kept as well.
// peerDependencies are not followed here — many are declared and never loaded. a peer
// an external package does import is found in the trace by `findSharedPackages`.
export interface Closure {
  external: Set<string>;
  reasons: Map<string, ExternalReason[]>;
}

export function expandClosure(
  detectedPackages: Set<string>,
  detectedReasons: Map<string, DetectReason[]>,
  cwd: string,
  packageDirs?: Map<string, string>,
): Closure {
  const external = new Set(detectedPackages);
  const reasons = new Map<string, ExternalReason[]>();

  for (const [pkg, rs] of detectedReasons) {
    reasons.set(pkg, [...rs]);
  }

  const queue: string[] = [...detectedPackages];

  const enqueueDep = (dep: string, from: string): void => {
    if (external.has(dep)) return;

    external.add(dep);
    reasons.set(dep, [{ reachableFrom: from }]);
    queue.push(dep);
  };

  while (queue.length > 0) {
    const pkg = queue.shift()!;
    const json = readPackageJson(cwd, pkg, packageDirs);

    if (!json) continue;

    const deps = [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.optionalDependencies ?? {})];

    for (const dep of deps) enqueueDep(dep, pkg);
  }

  return { external, reasons };
}
