import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectExternals } from '../src/bundle/detection';

function trace(opts: { files?: string[]; warnings?: (string | Error)[] }) {
  return {
    fileList: new Set(opts.files),
    esmFileList: new Set<string>(),
    reasons: new Map(),
    warnings: new Set((opts.warnings ?? []).map((w) => (w instanceof Error ? w : new Error(w)))),
  } as Parameters<typeof detectExternals>[0];
}

describe('detectExternals', () => {
  it('returns empty detection for a clean trace', () => {
    const detection = detectExternals(trace({ files: ['node_modules/lodash/index.js'] }), '/nonexistent');

    expect(detection.packages.size).toBe(0);
  });

  it('flags packages shipping .node files as native-bindings', () => {
    const detection = detectExternals(
      trace({ files: ['node_modules/sharp/build/Release/sharp.node'] }),
      '/nonexistent',
    );

    expect(detection.packages.has('sharp')).toBe(true);
    expect(detection.reasons.get('sharp')).toEqual(['native-bindings']);
  });

  it('flags scoped packages with .node files', () => {
    const detection = detectExternals(
      trace({ files: ['node_modules/@scope/native/build/native.node'] }),
      '/nonexistent',
    );

    expect(detection.packages.has('@scope/native')).toBe(true);
  });

  it('flags packages mentioned in NFT warnings as nft-warning', () => {
    const detection = detectExternals(
      trace({ warnings: ['Cannot statically analyze require() in node_modules/pino/lib/transport.js'] }),
      '/nonexistent',
    );

    expect(detection.packages.has('pino')).toBe(true);
    expect(detection.reasons.get('pino')).toEqual(['nft-warning']);
  });

  it('merges reasons when a package is flagged by multiple signals', () => {
    const detection = detectExternals(
      trace({
        files: ['node_modules/sharp/build/Release/sharp.node'],
        warnings: ['Failed to resolve dependency in node_modules/sharp/lib/index.js'],
      }),
      '/nonexistent',
    );

    expect(detection.reasons.get('sharp')).toEqual(['native-bindings', 'nft-warning']);
  });

  it('ignores warnings that do not reference node_modules', () => {
    const detection = detectExternals(trace({ warnings: ['unrelated warning text'] }), '/nonexistent');

    expect(detection.packages.size).toBe(0);
  });

  it('does not double-count when the same warning fires twice', () => {
    const detection = detectExternals(
      trace({
        warnings: [
          'Cannot statically analyze require() in node_modules/pino/lib/transport.js',
          'Cannot statically analyze require() in node_modules/pino/lib/worker.js',
        ],
      }),
      '/nonexistent',
    );

    expect(detection.reasons.get('pino')).toEqual(['nft-warning']);
  });
});

describe('detectExternals — node_modules AST scan', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'detect-nm-ast-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function installPackage(pkg: string, entry: string, src: string): string {
    const dir = join(tmp, 'node_modules', pkg);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
    writeFileSync(join(dir, entry), src);

    return `node_modules/${pkg}/${entry}`;
  }

  it('flags a package whose source calls eval(...) as ast-eval', () => {
    const file = installPackage('evil-eval', 'index.js', `export const run = (s) => eval(s);`);

    const detection = detectExternals(trace({ files: [file] }), tmp);

    expect(detection.packages.has('evil-eval')).toBe(true);
    expect(detection.reasons.get('evil-eval')).toContain('ast-eval');
  });

  it('flags a package whose source uses new Function(...) as ast-eval', () => {
    const file = installPackage('templater', 'compile.cjs', `module.exports = new Function('return 1');`);

    const detection = detectExternals(trace({ files: [file] }), tmp);

    expect(detection.packages.has('templater')).toBe(true);
    expect(detection.reasons.get('templater')).toContain('ast-eval');
  });

  it('flags a package that calls import.meta.resolve(...) as ast-import-meta-resolve', () => {
    const file = installPackage(
      'self-resolver',
      'index.mjs',
      `export const workerUrl = import.meta.resolve('./worker.mjs');`,
    );

    const detection = detectExternals(trace({ files: [file] }), tmp);

    expect(detection.packages.has('self-resolver')).toBe(true);
    expect(detection.reasons.get('self-resolver')).toContain('ast-import-meta-resolve');
  });

  it('flags a package that calls Module.register(...) as ast-module-register', () => {
    const file = installPackage(
      '@scope/loader-hook',
      'register.mjs',
      `import { register } from 'node:module';
       Module.register('./hook.mjs', import.meta.url);`,
    );

    const detection = detectExternals(trace({ files: [file] }), tmp);

    expect(detection.packages.has('@scope/loader-hook')).toBe(true);
    expect(detection.reasons.get('@scope/loader-hook')).toContain('ast-module-register');
  });
});

describe('detectExternals — bundled chunk __require scan', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'detect-bundle-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function installPackage(pkg: string) {
    const dir = join(tmp, 'node_modules', pkg);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg }));
  }

  function writeChunk(relPath: string, src: string) {
    const path = join(tmp, relPath);

    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, src);
  }

  it('flags an installed package referenced via __require in a bundled chunk', () => {
    installPackage('@opentelemetry/exporter-trace-otlp-proto');
    writeChunk('dist/server/chunks/otel.mjs', `__require("@opentelemetry/exporter-trace-otlp-proto");`);

    const detection = detectExternals(trace({ files: ['dist/server/chunks/otel.mjs'] }), tmp);

    expect(detection.packages.has('@opentelemetry/exporter-trace-otlp-proto')).toBe(true);
    expect(detection.reasons.get('@opentelemetry/exporter-trace-otlp-proto')).toEqual(['bundled-external']);
  });

  it('maps a subpath specifier back to its package name', () => {
    installPackage('some-pkg');
    writeChunk('dist/entry.mjs', `__require("some-pkg/lib/inner.js");`);

    const detection = detectExternals(trace({ files: ['dist/entry.mjs'] }), tmp);

    expect(detection.packages.has('some-pkg')).toBe(true);
  });

  it('flags an installed package referenced via literal import.meta.resolve in a bundled chunk', () => {
    installPackage('@duckduckgo/autoconsent');
    writeChunk('dist/main.mjs', `const url = import.meta.resolve("@duckduckgo/autoconsent");`);

    const detection = detectExternals(trace({ files: ['dist/main.mjs'] }), tmp);

    expect(detection.packages.has('@duckduckgo/autoconsent')).toBe(true);
    expect(detection.reasons.get('@duckduckgo/autoconsent')).toEqual(['bundled-external']);
  });

  it('does not flag a package that is not installed', () => {
    writeChunk('dist/entry.mjs', `__require("not-installed-pkg");`);

    const detection = detectExternals(trace({ files: ['dist/entry.mjs'] }), tmp);

    expect(detection.packages.has('not-installed-pkg')).toBe(false);
  });

  it('ignores builtin specifiers', () => {
    writeChunk('dist/entry.mjs', `__require("fs"); __require("node:path");`);

    const detection = detectExternals(trace({ files: ['dist/entry.mjs'] }), tmp);

    expect(detection.packages.size).toBe(0);
  });

  it('does not scan files inside node_modules through the bundle pass', () => {
    installPackage('some-pkg');
    // a node_modules file with a plain literal require is not a "hidden" reference;
    // the bundle pass must skip node_modules entirely.
    writeChunk('node_modules/other/index.js', `require("some-pkg");`);

    const detection = detectExternals(trace({ files: ['node_modules/other/index.js'] }), tmp);

    expect(detection.packages.has('some-pkg')).toBe(false);
  });
});
