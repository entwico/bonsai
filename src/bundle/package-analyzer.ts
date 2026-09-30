import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Parser } from 'acorn';
import { findPackageDir } from './package-utils';

export class PackageAnalyzer {
  private _cwd: string;
  private _verdict = new Map<string, boolean>();
  private _pkgJsonCache = new Map<string, any | null>();
  private _fileSafeCache = new Map<string, boolean>();

  constructor(cwd: string) {
    this._cwd = cwd;
  }

  private _packageRoot(specifier: string): string {
    const segments = specifier.split('/');

    return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
  }

  private _readPackageJson(pkgDir: string): any | null {
    const cached = this._pkgJsonCache.get(pkgDir);

    if (cached !== undefined) return cached;

    try {
      const json = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

      this._pkgJsonCache.set(pkgDir, json);

      return json;
    } catch {
      this._pkgJsonCache.set(pkgDir, null);

      return null;
    }
  }

  // walk the `exports` map (under ESM resolution) and the legacy hint fields
  // to find the file rolldown would start bundling from.
  private _findEsmEntry(pkgDir: string, pkgJson: any): string | null {
    const fromExports = this._walkExportsForImport(pkgJson.exports);
    const candidate = fromExports ?? pkgJson.module ?? (pkgJson.type === 'module' ? pkgJson.main : undefined);

    if (typeof candidate !== 'string') return null;

    return resolve(pkgDir, candidate);
  }

  private _walkExportsForImport(node: any, depth = 0): string | null {
    if (!node || depth > 32) return null;

    if (typeof node === 'string') return node;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = this._walkExportsForImport(item, depth + 1);

        if (found) return found;
      }

      return null;
    }

    if (typeof node !== 'object') return null;

    // prefer the root subpath
    if ('.' in node) {
      const found = this._walkExportsForImport((node as any)['.'], depth + 1);

      if (found) return found;
    }

    // honor only the `import` condition — skip `require` (CJS), `module`
    // (bundler hint), `default` (mixed), etc.
    if ('import' in node) return this._walkExportsForImport((node as any).import, depth + 1);

    return null;
  }

  // determines whether a single source file (and the relative-import subtree
  // reachable from it) is ESM all the way through. bare specifier imports are
  // ignored — they're decided per-package, not by this walk.
  private _isFileEsmSafe(filePath: string, isPkgTypeModule: boolean, visited: Set<string>): boolean {
    const cacheKey = `${filePath}|${isPkgTypeModule}`;
    const cached = this._fileSafeCache.get(cacheKey);

    if (cached !== undefined) return cached;

    if (visited.has(filePath)) return true;

    visited.add(filePath);

    if (this._classifyByExtension(filePath, isPkgTypeModule) === 'cjs') {
      this._fileSafeCache.set(cacheKey, false);

      return false;
    }

    let source: string;

    try {
      source = readFileSync(filePath, 'utf8');
    } catch {
      this._fileSafeCache.set(cacheKey, false);

      return false;
    }

    // cheap pre-filter: no relative-path strings ⇒ only bare specifier
    // imports are possible, which are safe by construction.
    if (!source.includes('./') && !source.includes('../')) {
      this._fileSafeCache.set(cacheKey, true);

      return true;
    }

    let ast: any;

    try {
      ast = Parser.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowHashBang: true,
      });
    } catch {
      // unparseable ESM — bail. rolldown would also fail on this.
      this._fileSafeCache.set(cacheKey, false);

      return false;
    }

    const dir = dirname(filePath);

    for (const node of ast.body) {
      let spec: string | undefined;

      if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type)) {
        spec = node.source?.value;
      }

      if (typeof spec !== 'string') continue;
      if (!spec.startsWith('.')) continue;

      const resolved = this._resolveRelativeImport(spec, dir);

      if (!resolved || !this._isFileEsmSafe(resolved, isPkgTypeModule, visited)) {
        this._fileSafeCache.set(cacheKey, false);

        return false;
      }
    }

    this._fileSafeCache.set(cacheKey, true);

    return true;
  }

  private _classifyByExtension(filePath: string, isPkgTypeModule: boolean): 'esm' | 'cjs' {
    if (filePath.endsWith('.cjs')) return 'cjs';
    if (filePath.endsWith('.mjs')) return 'esm';
    if (filePath.endsWith('.js')) return isPkgTypeModule ? 'esm' : 'cjs';

    return isPkgTypeModule ? 'esm' : 'cjs';
  }

  private _resolveRelativeImport(spec: string, fromDir: string): string | null {
    const base = resolve(fromDir, spec);
    const candidates = [
      base,
      `${base}.mjs`,
      `${base}.js`,
      `${base}.cjs`,
      join(base, 'index.mjs'),
      join(base, 'index.js'),
      join(base, 'index.cjs'),
    ];

    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not a file — try next
      }
    }

    return null;
  }

  private _analyze(pkgDir: string): boolean {
    const pkgJson = this._readPackageJson(pkgDir);

    if (!pkgJson) return false;

    const entry = this._findEsmEntry(pkgDir, pkgJson);

    if (!entry) return false;

    return this._isFileEsmSafe(entry, pkgJson.type === 'module', new Set());
  }

  // the package is looked up the way node would from the importer (nearest
  // `node_modules/<pkg>` walking up), so a nested copy is judged on its own
  // shape rather than on whichever version got hoisted to the top level.
  isSafeToBundle(specifier: string, importer?: string): boolean {
    const pkgRoot = this._packageRoot(specifier);
    const pkgDir = findPackageDir(pkgRoot, importer ? dirname(importer) : this._cwd);

    if (!pkgDir) return false;

    const cached = this._verdict.get(pkgDir);

    if (cached !== undefined) return cached;

    const safe = this._analyze(pkgDir);

    this._verdict.set(pkgDir, safe);

    return safe;
  }
}
