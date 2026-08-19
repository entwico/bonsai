import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
