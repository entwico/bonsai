import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vercel/nft', () => ({
  nodeFileTrace: vi.fn(),
}));

vi.mock('../src/bundle/rewrite', () => ({
  rewrite: vi.fn(),
}));

describe('prune', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bonsai-test-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when no entrypoints given', async () => {
    const { prune } = await import('../src/commands/prune');

    await expect(prune([])).rejects.toThrow('usage: bonsai prune <entrypoint>...');
  });

  it('deletes non-traced files and keeps traced files', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'pkg-a'), { recursive: true });
    mkdirSync(join(tempDir, 'node_modules', 'pkg-b'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = "a"');
    writeFileSync(join(tempDir, 'node_modules', 'pkg-a', 'extra.js'), 'module.exports = "extra"');
    writeFileSync(join(tempDir, 'node_modules', 'pkg-b', 'index.js'), 'module.exports = "b"');
    writeFileSync(join(tempDir, 'entry.mjs'), 'import "pkg-a"');

    const { nodeFileTrace } = await import('@vercel/nft');

    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/pkg-a/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', 'pkg-a', 'index.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'pkg-a', 'extra.js'))).toBe(false);
    expect(existsSync(join(tempDir, 'node_modules', 'pkg-b', 'index.js'))).toBe(false);
    expect(existsSync(join(tempDir, 'node_modules', 'pkg-b'))).toBe(false);
  });

  it('handles scoped packages', async () => {
    mkdirSync(join(tempDir, 'node_modules', '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'index.js'), 'export default 1');
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'utils.js'), 'export default 2');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');
    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/@scope/pkg/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');
    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'utils.js'))).toBe(false);
  });

  it('preserves package.json for traced packages even when NFT omits it', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'pkg-a'), { recursive: true });
    mkdirSync(join(tempDir, 'node_modules', '@scope', 'pkg-b'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'pkg-a', 'index.js'), 'module.exports = "a"');
    writeFileSync(join(tempDir, 'node_modules', 'pkg-a', 'package.json'), '{"name":"pkg-a"}');
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg-b', 'index.js'), 'export default "b"');
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg-b', 'package.json'), '{"name":"@scope/pkg-b"}');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');

    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/pkg-a/index.js', 'node_modules/@scope/pkg-b/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', 'pkg-a', 'package.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', '@scope', 'pkg-b', 'package.json'))).toBe(true);
  });

  it('preserves package.json for nested pnpm-style packages', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'outer', 'node_modules', 'inner'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'outer', 'package.json'), '{"name":"outer"}');
    writeFileSync(join(tempDir, 'node_modules', 'outer', 'index.js'), 'module.exports = 1');
    writeFileSync(join(tempDir, 'node_modules', 'outer', 'node_modules', 'inner', 'package.json'), '{"name":"inner"}');
    writeFileSync(join(tempDir, 'node_modules', 'outer', 'node_modules', 'inner', 'index.js'), 'module.exports = 2');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');

    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/outer/index.js', 'node_modules/outer/node_modules/inner/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', 'outer', 'package.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'outer', 'node_modules', 'inner', 'package.json'))).toBe(true);
  });

  it('strips `@types/*` packages even when traced', async () => {
    mkdirSync(join(tempDir, 'node_modules', '@types', 'node'), { recursive: true });
    mkdirSync(join(tempDir, 'node_modules', '@types', 'react'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', '@types', 'node', 'index.d.ts'), 'declare module "x";');
    writeFileSync(join(tempDir, 'node_modules', '@types', 'react', 'index.d.ts'), 'declare module "y";');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');

    // even though NFT happens to include an @types path in tracedSet (some
    // packages pull them in as runtime `dependencies`), they're pure
    // TypeScript declarations and must never reach production.
    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/@types/node/index.d.ts']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', '@types'))).toBe(false);
  });

  it('leaves other @scoped packages alone (sweep targets only `@types/`)', async () => {
    mkdirSync(join(tempDir, 'node_modules', '@scope', 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'index.js'), 'module.exports = 1');
    writeFileSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'package.json'), '{"name":"@scope/pkg"}');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');

    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/@scope/pkg/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./entry.mjs']);

    expect(existsSync(join(tempDir, 'node_modules', '@scope', 'pkg', 'index.js'))).toBe(true);
  });

  it('no-ops when no `@types/` dir exists', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
    writeFileSync(join(tempDir, 'entry.mjs'), '');

    const { nodeFileTrace } = await import('@vercel/nft');

    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['entry.mjs', 'node_modules/pkg/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await expect(prune(['./entry.mjs'])).resolves.not.toThrow();

    expect(existsSync(join(tempDir, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('recovers a __require-only external from a bundled chunk without --rewrite', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'recovered-pkg', 'lib'), { recursive: true });
    writeFileSync(
      join(tempDir, 'node_modules', 'recovered-pkg', 'package.json'),
      '{"name":"recovered-pkg","main":"index.js"}',
    );
    writeFileSync(join(tempDir, 'node_modules', 'recovered-pkg', 'index.js'), 'module.exports = 1');
    writeFileSync(join(tempDir, 'node_modules', 'recovered-pkg', 'lib', 'extra.js'), 'module.exports = "extra"');

    mkdirSync(join(tempDir, 'dist'), { recursive: true });
    writeFileSync(join(tempDir, 'dist', 'entry.mjs'), 'export const init = () => __require("recovered-pkg");');

    const { nodeFileTrace } = await import('@vercel/nft');

    // main trace sees the chunk but not recovered-pkg (NFT can't follow __require).
    // the supplemental trace of the recovered root then pulls in its index.js.
    vi.mocked(nodeFileTrace)
      .mockResolvedValueOnce({
        fileList: new Set(['dist/entry.mjs']),
        esmFileList: new Set(),
        reasons: new Map(),
        warnings: new Set(),
      })
      .mockResolvedValueOnce({
        fileList: new Set(['node_modules/recovered-pkg/index.js']),
        esmFileList: new Set(),
        reasons: new Map(),
        warnings: new Set(),
      });

    const { prune } = await import('../src/commands/prune');

    await prune(['./dist/entry.mjs']);

    // force-external preservation keeps the whole package, incl. the untraced extra.js.
    expect(existsSync(join(tempDir, 'node_modules', 'recovered-pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'recovered-pkg', 'lib', 'extra.js'))).toBe(true);
  });

  it('preserves entire directory tree for force-external packages under --rewrite', async () => {
    mkdirSync(join(tempDir, 'node_modules', 'native-pkg', 'lib', 'helpers'), { recursive: true });
    writeFileSync(join(tempDir, 'node_modules', 'native-pkg', 'package.json'), '{"name":"native-pkg"}');
    writeFileSync(join(tempDir, 'node_modules', 'native-pkg', 'index.js'), 'module.exports = 1');
    writeFileSync(join(tempDir, 'node_modules', 'native-pkg', 'lib', 'a.js'), 'module.exports = "a"');
    writeFileSync(join(tempDir, 'node_modules', 'native-pkg', 'lib', 'helpers', 'b.js'), 'module.exports = "b"');

    mkdirSync(join(tempDir, 'dist', 'server'), { recursive: true });
    writeFileSync(join(tempDir, 'dist', 'server', 'main.mjs'), '');

    const { rewrite } = await import('../src/bundle/rewrite');

    vi.mocked(rewrite).mockResolvedValue({
      classification: {
        external: new Set(['native-pkg']),
        reasons: new Map(),
      },
      outDirs: [join(tempDir, 'dist', 'server')],
    });

    const { nodeFileTrace } = await import('@vercel/nft');

    // NFT only sees the entry file; it can't trace into native-pkg's
    // dynamic requires. without the force-external dir preservation,
    // lib/a.js and lib/helpers/b.js would be deleted.
    vi.mocked(nodeFileTrace).mockResolvedValue({
      fileList: new Set(['dist/server/main.mjs', 'node_modules/native-pkg/index.js']),
      esmFileList: new Set(),
      reasons: new Map(),
      warnings: new Set(),
    });

    const { prune } = await import('../src/commands/prune');

    await prune(['./dist/server/main.mjs'], { rewrite: true });

    expect(existsSync(join(tempDir, 'node_modules', 'native-pkg', 'package.json'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'native-pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'native-pkg', 'lib', 'a.js'))).toBe(true);
    expect(existsSync(join(tempDir, 'node_modules', 'native-pkg', 'lib', 'helpers', 'b.js'))).toBe(true);
  });
});
