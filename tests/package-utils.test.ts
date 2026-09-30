import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPackageDir, packageDirOfFile, packageNameFromSpecifier, packageOfFile } from '../src/bundle/package-utils';

describe('packageOfFile', () => {
  it('extracts plain package name from hoisted layout', () => {
    expect(packageOfFile('node_modules/sharp/build/Release/sharp.node')).toBe('sharp');
  });

  it('extracts scoped package name', () => {
    expect(packageOfFile('node_modules/@opentelemetry/sdk-node/build/src/index.js')).toBe('@opentelemetry/sdk-node');
  });

  it('skips .pnpm virtual store and returns the leaf package', () => {
    expect(packageOfFile('node_modules/.pnpm/sharp@0.34.0/node_modules/sharp/build/Release/sharp.node')).toBe('sharp');
  });

  it('skips .pnpm virtual store with scoped leaf package', () => {
    expect(
      packageOfFile(
        'node_modules/.pnpm/@opentelemetry+sdk-node@0.55.0/node_modules/@opentelemetry/sdk-node/build/src/index.js',
      ),
    ).toBe('@opentelemetry/sdk-node');
  });

  it('skips .bin entries', () => {
    expect(packageOfFile('node_modules/.bin/tsc')).toBeNull();
  });

  it('returns null for paths outside node_modules', () => {
    expect(packageOfFile('src/index.ts')).toBeNull();
  });

  it('returns null for the empty path', () => {
    expect(packageOfFile('')).toBeNull();
  });
});

describe('packageNameFromSpecifier', () => {
  it('returns a plain package name unchanged', () => {
    expect(packageNameFromSpecifier('lodash')).toBe('lodash');
  });

  it('strips the subpath from a plain package specifier', () => {
    expect(packageNameFromSpecifier('pino/lib/transport.js')).toBe('pino');
  });

  it('keeps the scope and name of a scoped package', () => {
    expect(packageNameFromSpecifier('@opentelemetry/sdk-node')).toBe('@opentelemetry/sdk-node');
  });

  it('strips the subpath from a scoped package specifier', () => {
    expect(packageNameFromSpecifier('@opentelemetry/sdk-node/build/src/index.js')).toBe('@opentelemetry/sdk-node');
  });

  it('returns null for a scope with no package name', () => {
    expect(packageNameFromSpecifier('@opentelemetry')).toBeNull();
  });

  it('returns null for relative specifiers', () => {
    expect(packageNameFromSpecifier('./local.js')).toBeNull();
    expect(packageNameFromSpecifier('../up.js')).toBeNull();
  });

  it('returns null for absolute specifiers', () => {
    expect(packageNameFromSpecifier('/abs/path.js')).toBeNull();
  });

  it('returns null for node: builtins', () => {
    expect(packageNameFromSpecifier('node:fs')).toBeNull();
  });

  it('returns null for the empty specifier', () => {
    expect(packageNameFromSpecifier('')).toBeNull();
  });
});

describe('findPackageDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'find-package-dir-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the nearest copy walking up from the given directory', () => {
    const hoisted = join(tmp, 'node_modules', 'dual');
    const nested = join(tmp, 'node_modules', 'consumer', 'node_modules', 'dual');

    for (const dir of [hoisted, nested]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"dual"}');
    }

    expect(findPackageDir('dual', join(tmp, 'node_modules', 'consumer', 'lib'))).toBe(nested);
    expect(findPackageDir('dual', join(tmp, 'dist'))).toBe(hoisted);
    expect(findPackageDir('missing', tmp)).toBeNull();
  });
});

describe('packageDirOfFile', () => {
  it('returns the innermost copy of the package on the path', () => {
    expect(packageDirOfFile('/app/node_modules/consumer/node_modules/dual/lib/x.js', 'dual')).toBe(
      '/app/node_modules/consumer/node_modules/dual',
    );
    expect(packageDirOfFile('/app/node_modules/dual/lib/x.js', 'dual')).toBe('/app/node_modules/dual');
    expect(packageDirOfFile('/app/node_modules/.pnpm/dual@2/node_modules/dual/index.js', 'dual')).toBe(
      '/app/node_modules/.pnpm/dual@2/node_modules/dual',
    );
    expect(packageDirOfFile('/app/node_modules/@scope/pkg/index.js', '@scope/pkg')).toBe('/app/node_modules/@scope/pkg');
  });

  it('returns null when the file is not inside the package', () => {
    expect(packageDirOfFile('/app/node_modules/other/index.js', 'dual')).toBeNull();
  });
});
