import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rewrite } from '../src/bundle/rewrite';
import { sortByString } from '../src/utils/sort';

describe('rewrite preserves Function/Class .name through minification', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rewrite-keep-names-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the inferred name of a class returned from a factory arrow', async () => {
    const src = join(tmp, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'entry.mjs'),
      `
        const factory = () => class Session {};
        export const Cls = factory();
        export const fnName = (function namedFunction() {}).name;
      `,
    );

    const outDir = join(tmp, 'out');

    await rewrite({ entrypoints: [join(src, 'entry.mjs')], outDir, cwd: tmp });

    const mod = await import(pathToFileURL(join(outDir, 'entry.mjs')).href);

    expect(mod.Cls.name).toBe('Session');
    expect(mod.fnName).toBe('namedFunction');
  });
});

describe('rewrite output placement', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rewrite-placement-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rewrites each entry next to itself when entries live in different directories', async () => {
    const serverDist = join(tmp, 'packages', 'server', 'dist');
    const renderDist = join(tmp, 'packages', 'render', 'dist');

    mkdirSync(serverDist, { recursive: true });
    mkdirSync(renderDist, { recursive: true });
    writeFileSync(join(serverDist, 'main.mjs'), 'export const role = "server";');
    writeFileSync(join(renderDist, 'worker.mjs'), 'export const role = "worker";');

    const { outDirs } = await rewrite({
      entrypoints: [join(serverDist, 'main.mjs'), join(renderDist, 'worker.mjs')],
      cwd: tmp,
    });

    expect(outDirs.toSorted(sortByString)).toEqual([renderDist, serverDist].toSorted(sortByString));
    expect(existsSync(join(serverDist, 'worker.mjs'))).toBe(false);
    expect(existsSync(join(renderDist, 'main.mjs'))).toBe(false);

    const server = await import(pathToFileURL(join(serverDist, 'main.mjs')).href);
    const worker = await import(pathToFileURL(join(renderDist, 'worker.mjs')).href);

    expect(server.role).toBe('server');
    expect(worker.role).toBe('worker');
  });

  it('gathers all entries into outDir when it is given explicitly', async () => {
    const src = join(tmp, 'src');
    const dist = join(tmp, 'dist');

    mkdirSync(src, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'entry.mjs'), 'export const role = "entry";');
    writeFileSync(join(src, 'preload.mjs'), 'export const role = "preload";');

    const { outDirs } = await rewrite({
      entrypoints: [join(dist, 'entry.mjs'), join(src, 'preload.mjs')],
      outDir: dist,
      cwd: tmp,
    });

    expect(outDirs).toEqual([dist]);
    expect(existsSync(join(dist, 'preload.mjs'))).toBe(true);
  });
});

describe('rewrite unresolvable bare imports', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rewrite-unresolved-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // the analyzer approves a package by its root entry, but rolldown resolves
  // the full subpath — a miss must externalize, not fail the build.
  it('externalizes a bundleable package subpath rolldown cannot resolve', async () => {
    const pkgDir = join(tmp, 'node_modules', 'exports-pkg');

    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'exports-pkg', type: 'module', exports: { '.': { import: './index.js' } } }),
    );
    writeFileSync(join(pkgDir, 'index.js'), 'export const root = 1;');

    const dist = join(tmp, 'dist');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'entry.mjs'), 'import { sub } from "exports-pkg/sub";\nexport const value = sub;');

    const { classification } = await rewrite({ entrypoints: [join(dist, 'entry.mjs')], cwd: tmp });

    expect(classification.external.has('exports-pkg')).toBe(true);
    expect(classification.reasons.get('exports-pkg')).toContain('unresolved-import');

    const output = readFileSync(join(dist, 'entry.mjs'), 'utf8');

    expect(output).toMatch(/from\s*["']exports-pkg\/sub["']/);
  });
});

describe('rewrite nested package copies', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rewrite-nested-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePkg(dir: string, pkgJson: object, files: Record<string, string>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgJson));

    for (const [relPath, contents] of Object.entries(files)) {
      writeFileSync(join(dir, relPath), contents);
    }
  }

  function writeEntry(source: string): string {
    const dist = join(tmp, 'dist');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'entry.mjs'), source);

    return join(dist, 'entry.mjs');
  }

  // the hoisted copy is CJS without the subpath export; the copy the consumer
  // resolves to is ESM and must be bundled on its own merits.
  it('bundles a nested ESM copy even when the hoisted copy is not bundleable', async () => {
    writePkg(
      join(tmp, 'node_modules', 'dual'),
      { name: 'dual', version: '1.0.0', main: './index.js' },
      { 'index.js': 'module.exports = { value: "hoisted" };' },
    );
    writePkg(
      join(tmp, 'node_modules', 'consumer', 'node_modules', 'dual'),
      { name: 'dual', version: '2.0.0', type: 'module', exports: { '.': './index.js', './sub': './sub.js' } },
      { 'index.js': 'export const value = "nested";', 'sub.js': 'export const sub = "nested-sub";' },
    );
    writePkg(
      join(tmp, 'node_modules', 'consumer'),
      { name: 'consumer', type: 'module', main: './index.js' },
      { 'index.js': 'import { sub } from "dual/sub";\nexport const fromConsumer = sub;' },
    );

    const entry = writeEntry('export { fromConsumer } from "consumer";');
    const { classification, nestedExternals } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect(classification.external.has('dual')).toBe(false);
    expect(nestedExternals).toEqual([]);

    const output = readFileSync(entry, 'utf8');

    expect(output).not.toMatch(/["']dual\/sub["']/);

    const mod = await import(pathToFileURL(entry).href);

    expect(mod.fromConsumer).toBe('nested-sub');
  });

  // a nested external cannot keep its bare specifier: node would resolve it from
  // the bundle's location to the hoisted copy. it is referenced by relative path.
  it('references a nested external copy by relative path and the hoisted copy by bare specifier', async () => {
    writePkg(
      join(tmp, 'node_modules', 'dual'),
      { name: 'dual', version: '1.0.0', main: './index.js' },
      { 'index.js': 'module.exports = { value: "hoisted" };' },
    );

    const nestedDir = join(tmp, 'node_modules', 'consumer', 'node_modules', 'dual');

    writePkg(
      nestedDir,
      { name: 'dual', version: '2.0.0', main: './index.js' },
      { 'index.js': 'module.exports = { value: "nested" };' },
    );
    writePkg(
      join(tmp, 'node_modules', 'consumer'),
      { name: 'consumer', type: 'module', main: './index.js' },
      { 'index.js': 'import dual from "dual";\nexport const fromConsumer = dual.value;' },
    );

    const entry = writeEntry(
      'import dual from "dual";\nexport { fromConsumer } from "consumer";\nexport const fromEntry = dual.value;',
    );
    const { nestedExternals } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect(nestedExternals).toEqual([{ pkg: 'dual', dir: nestedDir, file: join(nestedDir, 'index.js') }]);

    const output = readFileSync(entry, 'utf8');

    expect(output).toMatch(/["']dual["']/);
    expect(output).toContain('../node_modules/consumer/node_modules/dual/index.js');

    const mod = await import(pathToFileURL(entry).href);

    expect(mod.fromEntry).toBe('hoisted');
    expect(mod.fromConsumer).toBe('nested');
  });
});

describe('rewrite packages shared with an external package', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'rewrite-shared-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePkg(name: string, pkgJson: object, files: Record<string, string>) {
    const dir = join(tmp, 'node_modules', name);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkgJson }));

    for (const [relPath, contents] of Object.entries(files)) {
      writeFileSync(join(dir, relPath), contents);
    }
  }

  function writeEntry(source: string): string {
    const dist = join(tmp, 'dist');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'entry.mjs'), source);

    return join(dist, 'entry.mjs');
  }

  const STATE_PKG = { type: 'module', exports: { '.': { import: './index.js' } } };
  const STATE_SOURCE = 'export const registry = new Set();\nexport const provide = (value) => registry.add(value);';
  const ENTRY_SOURCE = 'import { registry } from "state";\nimport { register } from "ui";\nregister();\nexport { registry };';

  it('keeps a peer external when a force-external package imports it', async () => {
    writePkg('state', STATE_PKG, { 'index.js': STATE_SOURCE });
    writePkg(
      'ui',
      { type: 'module', exports: { '.': { import: './index.js' } }, peerDependencies: { state: '*' } },
      {
        'index.js': [
          'import { provide } from "state";',
          'export const register = () => provide("ui");',
          'export const load = (name) => import(name);',
        ].join('\n'),
      },
    );

    const entry = writeEntry(ENTRY_SOURCE);
    const { classification } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect(classification.external.has('ui')).toBe(true);
    expect(classification.shared.has('state')).toBe(true);
    expect(classification.reasons.get('state')).toEqual([{ reachableFrom: 'ui' }]);
    expect(readFileSync(entry, 'utf8')).toMatch(/from\s*["']state["']/);

    const mod = await import(pathToFileURL(entry).href);

    expect([...mod.registry]).toEqual(['ui']);
  });

  it('keeps a package external when a package that cannot be bundled requires it', async () => {
    writePkg(
      'state',
      { type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } },
      {
        'index.js': STATE_SOURCE,
        'index.cjs': 'exports.registry = new Set();\nexports.provide = (value) => exports.registry.add(value);',
      },
    );
    writePkg(
      'ui',
      { main: './index.js' },
      { 'index.js': 'const { provide } = require("state");\nexports.register = () => provide("ui");' },
    );

    const entry = writeEntry(ENTRY_SOURCE);
    const { classification } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect(classification.shared.has('state')).toBe(true);
    expect(readFileSync(entry, 'utf8')).toMatch(/from\s*["']state["']/);
  });

  it('follows the trace transitively through shared packages', async () => {
    writePkg('store', STATE_PKG, { 'index.js': STATE_SOURCE });
    writePkg('state', STATE_PKG, { 'index.js': 'export { registry, provide } from "store";' });
    writePkg(
      'ui',
      { main: './index.js' },
      { 'index.js': 'exports.register = () => import("state").then((state) => state.provide("ui"));' },
    );

    const entry = writeEntry('import { registry } from "store";\nimport "ui";\nexport { registry };');
    const { classification } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect([...classification.shared].toSorted(sortByString)).toEqual(['state', 'store']);
    expect(readFileSync(entry, 'utf8')).toMatch(/from\s*["']store["']/);
  });

  it('still inlines a declared peer the external package never imports', async () => {
    writePkg('state', STATE_PKG, { 'index.js': STATE_SOURCE });
    writePkg(
      'ui',
      { main: './index.js', peerDependencies: { state: '*' } },
      { 'index.js': 'exports.register = () => {};' },
    );

    const entry = writeEntry(ENTRY_SOURCE);
    const { classification } = await rewrite({ entrypoints: [entry], cwd: tmp });

    expect(classification.shared.has('state')).toBe(false);
    expect(readFileSync(entry, 'utf8')).not.toMatch(/["']state["']/);
  });
});
