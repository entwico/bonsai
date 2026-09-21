import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '../src/bundle/trace';

describe('trace', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'trace-')));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function write(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(tmp, path);

      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
  }

  // a package shaped like pdfkit: an esm entry that loads dual-condition subpath
  // imports through createRequire
  function writeDualConditionPackage(entry: string) {
    write({
      'node_modules/fonts/package.json': JSON.stringify({
        name: 'fonts',
        exports: { '.': { import: './entry.mjs', require: './entry.cjs' } },
        imports: { '#fonts/*': { require: './fonts/*.cjs', default: './fonts/*.mjs' } },
      }),
      'node_modules/fonts/entry.mjs': entry,
      'node_modules/fonts/entry.cjs': 'module.exports = {};',
      'node_modules/fonts/fonts/Helvetica.cjs': 'module.exports = "cjs";',
      'node_modules/fonts/fonts/Helvetica.mjs': 'export default "mjs";',
    });
  }

  it('keeps both condition targets for require calls created by createRequire in an esm file', async () => {
    writeDualConditionPackage(`
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      export const helvetica = () => require('#fonts/Helvetica');
    `);
    write({ 'main.mjs': 'import \'fonts\';' });

    const result = await trace([join(tmp, 'main.mjs')], tmp);

    expect(result.fileList).toContain('node_modules/fonts/fonts/Helvetica.cjs');
    expect(result.fileList).toContain('node_modules/fonts/fonts/Helvetica.mjs');
  });

  it('keeps only the import target for static imports in an esm file without createRequire', async () => {
    writeDualConditionPackage('export { default as helvetica } from \'#fonts/Helvetica\';');
    write({ 'main.mjs': 'import \'fonts\';' });

    const result = await trace([join(tmp, 'main.mjs')], tmp);

    expect(result.fileList).toContain('node_modules/fonts/fonts/Helvetica.mjs');
    expect(result.fileList).not.toContain('node_modules/fonts/fonts/Helvetica.cjs');
  });

  it('leaves cjs parents on the require target only', async () => {
    writeDualConditionPackage('export default 1;');
    write({ 'main.cjs': 'require(\'fonts/package.json\'); require(\'fonts\');' });

    const result = await trace([join(tmp, 'main.cjs')], tmp);

    expect(result.fileList).toContain('node_modules/fonts/entry.cjs');
    expect(result.fileList).not.toContain('node_modules/fonts/entry.mjs');
  });
});
