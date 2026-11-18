import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackageAnalyzer } from '../src/bundle/package-analyzer';

function makeIsExternal(cwd: string): (id: string) => boolean {
  const analyzer = new PackageAnalyzer(cwd);

  return (id) => {
    if (id.startsWith('.') || id.startsWith('/')) return false;
    if (id.startsWith('node:')) return true;

    return !analyzer.isSafeToBundle(id);
  };
}

describe('PackageAnalyzer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'package-analyzer-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePkg(name: string, pkgJson: object, files: Record<string, string> = {}) {
    const dir = join(tmp, 'node_modules', name);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkgJson }));

    for (const [relPath, contents] of Object.entries(files)) {
      const full = join(dir, relPath);

      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
  }

  it('returns true (safe) for a fully-ESM package', () => {
    writePkg('pure-esm', { type: 'module', main: './index.js' }, { 'index.js': 'export default 1;' });

    expect(new PackageAnalyzer(tmp).isSafeToBundle('pure-esm')).toBe(true);
  });

  it('returns false (external) for a CJS package', () => {
    writePkg('cjs-pkg', { main: './index.js' }, { 'index.js': 'module.exports = 1;' });

    expect(new PackageAnalyzer(tmp).isSafeToBundle('cjs-pkg')).toBe(false);
  });

  it('returns false (external) for a missing package', () => {
    expect(new PackageAnalyzer(tmp).isSafeToBundle('missing')).toBe(false);
  });

  it('caches verdicts (second call same result, no re-read)', () => {
    writePkg('cached', { type: 'module', main: './index.js' }, { 'index.js': '' });

    const analyzer = new PackageAnalyzer(tmp);

    expect(analyzer.isSafeToBundle('cached')).toBe(true);
    // mutate package.json — verdict should not change because of cache
    writeFileSync(
      join(tmp, 'node_modules', 'cached', 'package.json'),
      JSON.stringify({ name: 'cached', main: './index.js' }),
    );
    expect(analyzer.isSafeToBundle('cached')).toBe(true);
  });

  it('handles package.json with broken JSON', () => {
    const dir = join(tmp, 'node_modules', 'broken');

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{ not json');

    expect(new PackageAnalyzer(tmp).isSafeToBundle('broken')).toBe(false);
  });

  it('treats subpath imports the same as their package root', () => {
    writePkg('pkg-with-subpath', { type: 'module', main: './index.js' }, { 'index.js': '' });

    const analyzer = new PackageAnalyzer(tmp);

    expect(analyzer.isSafeToBundle('pkg-with-subpath/deep/inner.js')).toBe(true);
  });

  it('strips the scope and first segment for scoped specifiers', () => {
    writePkg('@scope/pkg', { type: 'module', main: './index.js' }, { 'index.js': '' });

    const analyzer = new PackageAnalyzer(tmp);

    expect(analyzer.isSafeToBundle('@scope/pkg/sub/path')).toBe(true);
  });

  it('judges the copy the importer resolves to, not the hoisted one', () => {
    writePkg('dual', { main: './index.js' }, { 'index.js': 'module.exports = 1;' });
    writePkg('consumer/node_modules/dual', { type: 'module', main: './index.js' }, { 'index.js': 'export default 1;' });

    const analyzer = new PackageAnalyzer(tmp);
    const importer = join(tmp, 'node_modules', 'consumer', 'index.js');

    expect(analyzer.isSafeToBundle('dual', importer)).toBe(true);
    expect(analyzer.isSafeToBundle('dual/sub', importer)).toBe(true);
    expect(analyzer.isSafeToBundle('dual')).toBe(false);
    expect(analyzer.isSafeToBundle('dual', join(tmp, 'dist', 'entry.mjs'))).toBe(false);
  });
});

describe('rewrite external callback (inline at the rolldown call site)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rewrite-external-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePkg(name: string, pkgJson: object, files: Record<string, string> = {}) {
    const dir = join(tmp, 'node_modules', name);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkgJson }));

    for (const [relPath, contents] of Object.entries(files)) {
      const full = join(dir, relPath);

      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
  }

  it('keeps node: builtins external', () => {
    const isExternal = makeIsExternal(tmp);

    expect(isExternal('node:fs')).toBe(true);
    expect(isExternal('node:path')).toBe(true);
  });

  it('bundles relative and absolute specifiers (rolldown handles them)', () => {
    const isExternal = makeIsExternal(tmp);

    expect(isExternal('./local.mjs')).toBe(false);
    expect(isExternal('../sibling.js')).toBe(false);
    expect(isExternal('/abs/path.mjs')).toBe(false);
  });

  it('externalizes packages we cannot find', () => {
    const isExternal = makeIsExternal(tmp);

    expect(isExternal('not-installed')).toBe(true);
  });

  it('externalizes a CJS package', () => {
    writePkg('legacy-cjs', { main: './index.js' }, { 'index.js': 'module.exports = 1;' });

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('legacy-cjs')).toBe(true);
  });

  it('bundles a `type: module` package whose entry imports only bare specifiers', () => {
    writePkg(
      'modern-esm',
      { type: 'module', main: './index.js', dependencies: { 'some-cjs': '*' } },
      { 'index.js': 'import x from \'some-cjs\';\nexport default x;' },
    );
    writePkg('some-cjs', { main: './index.js' }, { 'index.js': 'module.exports = 1;' });

    const isExternal = makeIsExternal(tmp);

    // ESM parent is safe to bundle even though one of its deps is CJS — the
    // bare-specifier import is decided per-package and `some-cjs` ends up
    // external on its own.
    expect(isExternal('modern-esm')).toBe(false);
    expect(isExternal('some-cjs')).toBe(true);
  });

  it('bundles a dual-format ESM package whose .mjs only imports bare specifiers (radix-shape)', () => {
    // matches the @radix-ui/react-* shape: no `type: module`, dual `.js` /
    // `.mjs` build, the `.mjs` entry only imports peer/dep packages by name.
    writePkg(
      '@radix/widget',
      { module: './dist/index.mjs', main: './dist/index.js' },
      {
        'dist/index.mjs': 'import * as React from \'react\';\nexport const Widget = () => null;',
        'dist/index.js': 'module.exports = {};',
      },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('@radix/widget')).toBe(false);
  });

  // a relative `.js` import in a package without `type: module` lands on CJS;
  // inlining it would hide its require() calls from the trace.
  it('externalizes an ESM facade that re-exports a CJS sibling', () => {
    writePkg(
      'koa',
      {
        exports: { '.': { import: './dist/koa.mjs', require: './lib/application.js' } },
      },
      {
        'dist/koa.mjs': 'import mod from "../lib/application.js";\nexport default mod;',
        'lib/application.js': 'module.exports = {};',
      },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('koa')).toBe(true);
  });

  // partner case: oidc-provider is pure ESM (`type: module`) and only
  // imports koa as a bare specifier. it should bundle — the koa import goes
  // through the matcher and gets externalized on its own merits.
  it('bundles an ESM package even if a bare-specifier dep is unsafe', () => {
    writePkg(
      'oidc-provider',
      { type: 'module', main: './lib/index.js', dependencies: { koa: '*' } },
      { 'lib/index.js': 'import Koa from \'koa\';\nexport default Koa;' },
    );
    writePkg(
      'koa',
      { exports: { '.': { import: './dist/koa.mjs', require: './lib/application.js' } } },
      {
        'dist/koa.mjs': 'import mod from "../lib/application.js";\nexport default mod;',
        'lib/application.js': 'module.exports = {};',
      },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('oidc-provider')).toBe(false);
    expect(isExternal('koa')).toBe(true);
  });

  it('externalizes a `type: module` package whose entry pulls a sibling .cjs', () => {
    // explicit `.cjs` extension is unambiguously CJS regardless of `type`.
    writePkg(
      'esm-with-cjs-sibling',
      { type: 'module', main: './index.js' },
      {
        'index.js': 'import x from \'./native-binding.cjs\';\nexport default x;',
        'native-binding.cjs': 'module.exports = {};',
      },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('esm-with-cjs-sibling')).toBe(true);
  });

  it('handles relative-import cycles inside a package without infinite recursion', () => {
    writePkg(
      'cycle-pkg',
      { type: 'module', main: './a.js' },
      {
        'a.js': 'import b from \'./b.js\';\nexport default b;',
        'b.js': 'import a from \'./a.js\';\nexport default a;',
      },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('cycle-pkg')).toBe(false);
  });

  it('externalizes when entry imports an unresolvable relative path', () => {
    writePkg(
      'broken',
      { type: 'module', main: './index.js' },
      { 'index.js': 'import x from \'./does-not-exist.js\';\nexport default x;' },
    );

    const isExternal = makeIsExternal(tmp);

    expect(isExternal('broken')).toBe(true);
  });
});
