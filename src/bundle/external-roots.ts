import { existsSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, join } from 'node:path';

// rolldown wraps CJS requires in helpers (__require, __toESM) that NFT
// doesn't recognize as import edges, so externals from the bundled
// output are invisible to NFT's post-rewrite trace. this feeds them
// back to NFT as explicit roots.
export function resolveExternalRoots(external: Set<string>, cwd: string): string[] {
  const localRequire = createRequire(import.meta.url);
  const out: string[] = [];

  for (const pkg of external) {
    // builtins (e.g. `punycode`) need no node_modules entry at runtime; node provides them.
    if (isBuiltin(pkg)) continue;

    let resolved: string | null = null;

    try {
      const r = localRequire.resolve(pkg, { paths: [cwd] });

      // require.resolve returns the bare name for shadowed builtins; ignore those.
      if (isAbsolute(r)) resolved = r;
    } catch {
      // resolution failed; the package.json fallback below handles it
    }

    if (resolved) {
      out.push(resolved);
      continue;
    }

    // no main / broken exports / resolved to builtin — fall back to package.json
    // so the package directory at least gets kept.
    const pkgJson = join(cwd, 'node_modules', pkg, 'package.json');

    if (existsSync(pkgJson)) out.push(pkgJson);
  }

  return out;
}
