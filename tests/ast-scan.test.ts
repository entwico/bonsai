import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanBundleExternals, scanFile } from '../src/bundle/ast-scan';

describe('scanFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ast-scan-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(name: string, src: string): string {
    const path = join(tmp, name);

    writeFileSync(path, src);

    return path;
  }

  it('returns no reasons for inert source', () => {
    const path = write('a.js', 'export const x = 1;');

    expect(scanFile(path)).toEqual([]);
  });

  it('returns no reasons for missing files', () => {
    expect(scanFile(join(tmp, 'does-not-exist.js'))).toEqual([]);
  });

  it('flags new Worker(...) as ast-worker', () => {
    const path = write(
      'a.js',
      `import { Worker } from 'node:worker_threads';
       new Worker(new URL('./w.mjs', import.meta.url));`,
    );

    expect(scanFile(path)).toContain('ast-worker');
  });

  it('flags namespaced new worker_threads.Worker(...) as ast-worker', () => {
    const path = write(
      'a.cjs',
      `const wt = require('node:worker_threads');
       new wt.Worker('./w.cjs');`,
    );

    expect(scanFile(path)).toContain('ast-worker');
  });

  it('flags child_process.fork(...) via default import as ast-fork', () => {
    const path = write(
      'a.js',
      `import cp from 'node:child_process';
       cp.fork('./worker.js');`,
    );

    expect(scanFile(path)).toContain('ast-fork');
  });

  it('flags fork(...) imported by name from child_process as ast-fork', () => {
    const path = write(
      'a.js',
      `import { fork } from 'child_process';
       fork('./worker.js');`,
    );

    expect(scanFile(path)).toContain('ast-fork');
  });

  it('flags fork via CJS namespace require as ast-fork', () => {
    const path = write(
      'a.js',
      `const cp = require('node:child_process');
       cp.fork('./worker.js');`,
    );

    expect(scanFile(path)).toContain('ast-fork');
  });

  it('flags fork via CJS destructuring as ast-fork', () => {
    const path = write(
      'a.js',
      `const { fork } = require('child_process');
       fork('./worker.js');`,
    );

    expect(scanFile(path)).toContain('ast-fork');
  });

  it('flags fork via CJS destructuring with alias as ast-fork', () => {
    const path = write(
      'a.js',
      `const { fork: spawnFork } = require('child_process');
       spawnFork('./worker.js');`,
    );

    expect(scanFile(path)).toContain('ast-fork');
  });

  it('does NOT flag .fork() on an unrelated object', () => {
    // common false-positive pattern: protobuf builders, immutable-data libs, etc.
    const path = write(
      'a.js',
      `const builder = makeBuilder();
       builder.fork({ option: 1 });`,
    );

    expect(scanFile(path)).not.toContain('ast-fork');
  });

  it('does NOT flag fork() when imported from somewhere other than child_process', () => {
    const path = write(
      'a.js',
      `import { fork } from 'some-fluent-api';
       fork({ option: 1 });`,
    );

    expect(scanFile(path)).not.toContain('ast-fork');
  });

  it('flags Module.register(...) as ast-module-register', () => {
    const path = write(
      'a.js',
      `import { register } from 'node:module';
       Module.register('./hook.mjs', import.meta.url);`,
    );

    expect(scanFile(path)).toContain('ast-module-register');
  });

  it('flags eval(...) as ast-eval', () => {
    const path = write('a.js', `eval('1 + 1');`);

    expect(scanFile(path)).toContain('ast-eval');
  });

  it('flags new Function(...) as ast-eval', () => {
    const path = write('a.js', `new Function('return 1')();`);

    expect(scanFile(path)).toContain('ast-eval');
  });

  it('flags non-literal require(varName) as ast-dyn-require', () => {
    const path = write('a.cjs', `const name = process.env.X; require(name);`);

    expect(scanFile(path)).toContain('ast-dyn-require');
  });

  it('does NOT flag require("literal") as ast-dyn-require', () => {
    const path = write('a.cjs', `require('lodash');`);

    expect(scanFile(path)).not.toContain('ast-dyn-require');
  });

  it('flags non-literal import(varName) as ast-dyn-import', () => {
    const path = write('a.mjs', `const name = './x.mjs'; await import(name);`);

    expect(scanFile(path)).toContain('ast-dyn-import');
  });

  it('does NOT flag import("./literal") as ast-dyn-import', () => {
    const path = write('a.mjs', `await import('./x.mjs');`);

    expect(scanFile(path)).not.toContain('ast-dyn-import');
  });

  it('flags imports of import-in-the-middle as ast-loader-patch', () => {
    const path = write('a.mjs', `import { register } from 'import-in-the-middle';`);

    expect(scanFile(path)).toContain('ast-loader-patch');
  });

  it('flags require("require-in-the-middle") (literal CJS) as ast-loader-patch', () => {
    const path = write('a.cjs', `const Hook = require('require-in-the-middle');`);

    expect(scanFile(path)).toContain('ast-loader-patch');
  });

  it('flags require(`require-in-the-middle`) via template literal as ast-loader-patch', () => {
    const path = write('template-require.js', 'const ritm = require(`require-in-the-middle`);');

    expect(scanFile(path)).toEqual(['ast-loader-patch']);
  });

  it('does NOT flag require(`literal template`) as ast-dyn-require', () => {
    const path = write('template-literal-require.js', 'const x = require(`lodash`);');

    expect(scanFile(path)).toEqual([]);
  });

  it('flags imports of require-in-the-middle (ESM) as ast-loader-patch', () => {
    const path = write('a.mjs', `import Hook from 'require-in-the-middle';`);

    expect(scanFile(path)).toContain('ast-loader-patch');
  });

  it('flags imports of shimmer as ast-loader-patch', () => {
    const path = write('a.mjs', `import shimmer from 'shimmer';`);

    expect(scanFile(path)).toContain('ast-loader-patch');
  });

  it('flags imports of thread-stream as ast-worker (worker-spawn machinery)', () => {
    const path = write('a.mjs', `import ThreadStream from 'thread-stream';`);

    expect(scanFile(path)).toContain('ast-worker');
  });

  it('flags require("thread-stream") (literal CJS) as ast-worker', () => {
    const path = write('a.cjs', `const ThreadStream = require('thread-stream');`);

    expect(scanFile(path)).toContain('ast-worker');
  });

  it('flags imports of piscina as ast-worker', () => {
    const path = write('a.mjs', `import Piscina from 'piscina';`);

    expect(scanFile(path)).toContain('ast-worker');
  });

  it('flags import.meta.resolve(...) with a literal argument as ast-import-meta-resolve', () => {
    const path = write('a.mjs', `const url = import.meta.resolve('./worker.mjs');`);

    expect(scanFile(path)).toContain('ast-import-meta-resolve');
  });

  it('flags import.meta.resolve(...) with a non-literal argument as ast-import-meta-resolve', () => {
    const path = write('a.mjs', `const url = import.meta.resolve(name);`);

    expect(scanFile(path)).toContain('ast-import-meta-resolve');
  });

  it('does NOT flag an unrelated .resolve(...) member call', () => {
    const path = write('a.mjs', `import.meta.resolve; const p = path.resolve('./x'); require(p);`);

    expect(scanFile(path)).not.toContain('ast-import-meta-resolve');
  });

  it('does not flag substrings inside string literals or comments alone', () => {
    const path = write('a.js', `export const docs = "see how to use it"; // a perfectly innocent file`);

    expect(scanFile(path)).toEqual([]);
  });

  it('survives parse errors gracefully (returns empty)', () => {
    const path = write('a.js', `this is not valid javascript {{{`);

    expect(scanFile(path)).toEqual([]);
  });

  it('returns multiple distinct reasons when several patterns appear', () => {
    const path = write(
      'a.js',
      `import { Worker } from 'node:worker_threads';
       import 'shimmer';
       new Worker('./w.js');
       eval('x');`,
    );

    const reasons = scanFile(path);

    expect(reasons).toContain('ast-worker');
    expect(reasons).toContain('ast-loader-patch');
    expect(reasons).toContain('ast-eval');
  });
});

describe('scanBundleExternals', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'bundle-externals-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(name: string, src: string): string {
    const path = join(tmp, name);

    writeFileSync(path, src);

    return path;
  }

  it('recovers a specifier from rolldown __require(...)', () => {
    const path = write('chunk.mjs', `const otlp = __require("@opentelemetry/exporter-trace-otlp-proto");`);

    expect(scanBundleExternals(path)).toEqual(['@opentelemetry/exporter-trace-otlp-proto']);
  });

  it('recovers a specifier from a plain require(...) call', () => {
    const path = write('chunk.cjs', `const lodash = require('lodash');`);

    expect(scanBundleExternals(path)).toEqual(['lodash']);
  });

  it('recovers a __require nested inside __toESM(...)', () => {
    const path = write('chunk.mjs', `const mod = __toESM(__require("some-pkg"), 1);`);

    expect(scanBundleExternals(path)).toEqual(['some-pkg']);
  });

  it('returns subpath specifiers verbatim', () => {
    const path = write('chunk.mjs', `__require("pkg/sub/deep.js");`);

    expect(scanBundleExternals(path)).toEqual(['pkg/sub/deep.js']);
  });

  it('deduplicates repeated specifiers', () => {
    const path = write('chunk.mjs', `__require("pkg"); __require("pkg");`);

    expect(scanBundleExternals(path)).toEqual(['pkg']);
  });

  it('ignores non-literal require arguments', () => {
    const path = write('chunk.cjs', `const name = process.env.X; require(name);`);

    expect(scanBundleExternals(path)).toEqual([]);
  });

  it('recovers a specifier from literal import.meta.resolve(...)', () => {
    const path = write('chunk.mjs', `const url = import.meta.resolve("@duckduckgo/autoconsent");`);

    expect(scanBundleExternals(path)).toEqual(['@duckduckgo/autoconsent']);
  });

  it('recovers a subpath specifier from literal import.meta.resolve(...)', () => {
    const path = write('chunk.mjs', `import.meta.resolve("pkg/dist/inner.js");`);

    expect(scanBundleExternals(path)).toEqual(['pkg/dist/inner.js']);
  });

  it('ignores non-literal import.meta.resolve arguments', () => {
    const path = write('chunk.mjs', `const name = process.env.X; import.meta.resolve(name);`);

    expect(scanBundleExternals(path)).toEqual([]);
  });

  // minifiers rewrite string literals into template literals
  it('recovers a specifier from a zero-expression template literal', () => {
    const path = write('chunk.mjs', 'const url = import.meta.resolve(`@fontsource/inter/files/x.woff`);');

    expect(scanBundleExternals(path)).toEqual(['@fontsource/inter/files/x.woff']);
  });

  it('recovers a template-literal specifier from __require(...)', () => {
    const path = write('chunk.mjs', 'const mod = __require(`some-pkg`);');

    expect(scanBundleExternals(path)).toEqual(['some-pkg']);
  });

  it('ignores template literals with expressions', () => {
    const path = write('chunk.mjs', 'const v = `x`; import.meta.resolve(`pkg/${v}`); __require(`pkg-${v}`);');

    expect(scanBundleExternals(path)).toEqual([]);
  });

  it('does not treat static import/export as require specifiers', () => {
    const path = write('chunk.mjs', `import x from 'pino'; export { y } from 'sharp';`);

    expect(scanBundleExternals(path)).toEqual([]);
  });

  it('returns empty when the file has no require call at all', () => {
    const path = write('chunk.mjs', `export const x = 1;`);

    expect(scanBundleExternals(path)).toEqual([]);
  });

  it('returns empty for missing files', () => {
    expect(scanBundleExternals(join(tmp, 'nope.mjs'))).toEqual([]);
  });

  it('survives parse errors gracefully', () => {
    const path = write('chunk.mjs', `__require("pkg"); this is not valid {{{`);

    expect(scanBundleExternals(path)).toEqual([]);
  });
});
