import { expandClosure } from './closure';
import { detectExternals } from './detection';
import { indexTracedPackages } from './package-utils';
import { trace } from './trace';
import type { Classification } from './types';

export async function classify(entrypoints: string[], cwd: string): Promise<Classification> {
  const traced = await trace(entrypoints, cwd);
  const packageDirs = indexTracedPackages(traced.fileList, cwd);
  const detection = detectExternals(traced, cwd);
  const { external, reasons } = expandClosure(detection.packages, detection.reasons, cwd, packageDirs);

  return { external, reasons };
}
