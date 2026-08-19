import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type RewriteResult, rewrite } from '../../src/bundle/rewrite';
import { writeDebug } from '../util/debug.js';

const ROOT = join(import.meta.dirname, '..', '..', 'samples', 'astro-app');
const SERVER_DIR = join(ROOT, 'dist', 'server');
const ENTRY = join(SERVER_DIR, 'entry.mjs');
const INSTRUMENT = join(ROOT, 'src', 'instrument.mjs');
const SETUP_TIMEOUT = 120_000;

function readAllMjsRecursively(dir: string): string {
  let combined = '';

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      combined += readAllMjsRecursively(path);
    } else if (name.endsWith('.mjs')) {
      combined += readFileSync(path, 'utf8');
      combined += '\n';
    }
  }

  return combined;
}

describe('rewrite samples/astro-app', () => {
  let result: RewriteResult;
  let combinedOutput: string;

  beforeAll(async () => {
    if (!existsSync(ENTRY)) {
      throw new Error(`${ENTRY} not found — run 'pnpm test:sample:astro' first.`);
    }

    result = await rewrite({ entrypoints: [ENTRY, INSTRUMENT], outDir: SERVER_DIR, cwd: ROOT });

    combinedOutput = readAllMjsRecursively(SERVER_DIR);

    writeDebug('rewrite-astro.json', {
      external: result.classification.external,
      reasons: result.classification.reasons,
      outDirs: result.outDirs,
      outFiles: readdirSync(SERVER_DIR).map((f) => {
        const path = join(SERVER_DIR, f);
        const stat = statSync(path);

        return { name: f, size: stat.isFile() ? stat.size : null };
      }),
      combinedOutputBytes: combinedOutput.length,
    });
  }, SETUP_TIMEOUT);

  it('writes the rebundled entry.mjs', () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it('writes the rebundled instrument.mjs alongside', () => {
    expect(existsSync(join(SERVER_DIR, 'instrument.mjs'))).toBe(true);
  });

  // transitive externals (thread-stream, require-in-the-middle, …) don't
  // appear in the bundle output — they're imported by their externalized
  // parents at runtime. only assert what user code imports directly.
  it('keeps sharp as a runtime import', () => {
    expect(combinedOutput).toMatch(/from\s*["']sharp["']/);
  });

  it('keeps pino as a runtime import', () => {
    expect(combinedOutput).toMatch(/from\s*["']pino["']/);
  });

  it('keeps @opentelemetry/sdk-node as a runtime import', () => {
    expect(combinedOutput).toMatch(/from\s*["']@opentelemetry\/sdk-node["']/);
  });

  // rolldown doesn't recognize `new URL(..., import.meta.url)` as an asset
  // reference, so worker files passed via that pattern get lost. when this
  // changes, vitest will report "expected fail but passed" and the marker
  // should come off.
  it.fails('preserves files referenced via new URL(..., import.meta.url) in rebundled output', () => {
    const filesInOutput = collectFilesRecursive(SERVER_DIR);
    const urlReferencePattern = /new\s+URL\(\s*["']([^"']+\.[mc]?js)["']\s*,\s*import\.meta\.url\s*\)/g;
    const missing: string[] = [];

    for (const file of filesInOutput) {
      if (!file.endsWith('.mjs') && !file.endsWith('.js') && !file.endsWith('.cjs')) continue;

      const content = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;

      while ((match = urlReferencePattern.exec(content)) !== null) {
        const target = join(file, '..', match[1]);

        if (!existsSync(target)) {
          missing.push(`${file} → ${match[1]} (resolved to ${target})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

function collectFilesRecursive(dir: string): string[] {
  const out: string[] = [];

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);

    if (stat.isDirectory()) out.push(...collectFilesRecursive(path));
    else out.push(path);
  }

  return out;
}
