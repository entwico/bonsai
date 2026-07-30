import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import type { NodeFileTraceResult } from '@vercel/nft';
import { scanBundleExternals, scanFile } from './ast-scan';
import { packageExists, packageNameFromSpecifier, packageOfFile } from './package-utils';
import type { DetectReason } from './types';

export interface Detection {
  packages: Set<string>;
  reasons: Map<string, DetectReason[]>;
}

export function detectExternals(trace: NodeFileTraceResult, cwd: string): Detection {
  const packages = new Set<string>();
  const reasons = new Map<string, DetectReason[]>();

  function add(pkg: string, reason: DetectReason) {
    packages.add(pkg);

    const existing = reasons.get(pkg);

    if (existing) {
      if (!existing.includes(reason)) existing.push(reason);
    } else {
      reasons.set(pkg, [reason]);
    }
  }

  for (const file of trace.fileList) {
    if (!file.endsWith('.node')) {
      continue;
    }

    const pkg = packageOfFile(file);

    if (pkg) add(pkg, 'native-bindings');
  }

  for (const w of trace.warnings) {
    const msg = w instanceof Error ? w.message : String(w);
    const pkg = packageOfWarningMessage(msg);

    if (pkg) add(pkg, 'nft-warning');
  }

  for (const file of trace.fileList) {
    if (!file.startsWith('node_modules/') && !file.includes('/node_modules/')) continue;
    if (!file.endsWith('.js') && !file.endsWith('.cjs') && !file.endsWith('.mjs')) continue;

    const pkg = packageOfFile(file);

    if (!pkg) continue;

    const fullPath = join(cwd, file);
    const found = scanFile(fullPath);

    for (const reason of found) add(pkg, reason);
  }

  for (const pkg of detectBundleExternals(trace, cwd)) {
    add(pkg, 'bundled-external');
  }

  return { packages, reasons };
}

// scan the app's own bundled chunks (outside node_modules) for installed packages
// referenced via rolldown's __require(...) helper or literal import.meta.resolve(),
// neither of which NFT follows.
export function detectBundleExternals(trace: NodeFileTraceResult, cwd: string): Set<string> {
  const packages = new Set<string>();

  for (const file of trace.fileList) {
    if (file.startsWith('node_modules/') || file.includes('/node_modules/')) continue;
    if (!file.endsWith('.js') && !file.endsWith('.cjs') && !file.endsWith('.mjs')) continue;

    const fullPath = join(cwd, file);

    for (const spec of scanBundleExternals(fullPath)) {
      const pkg = packageNameFromSpecifier(spec);

      if (pkg && !isBuiltin(pkg) && packageExists(cwd, pkg)) {
        packages.add(pkg);
      }
    }
  }

  return packages;
}

// pnpm's symlink layout puts files under node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...
// so a naive first-match grabs `.pnpm`; iterate and pick the last non-dot segment, like packageOfFile.
function packageOfWarningMessage(msg: string): string | null {
  let last: string | null = null;

  for (const m of msg.matchAll(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/g)) {
    const name = m[1];

    if (name.startsWith('.')) continue;

    last = name;
  }

  return last;
}
