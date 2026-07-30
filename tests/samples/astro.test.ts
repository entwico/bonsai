import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../../src/bundle/classify';
import type { Classification } from '../../src/bundle/types';
import { writeDebug } from '../util/debug.js';

const ROOT = join(import.meta.dirname, '..', '..', 'samples', 'astro-app');
const ENTRY = join(ROOT, 'dist', 'server', 'entry.mjs');
const INSTRUMENT = join(ROOT, 'src', 'instrument.mjs');

describe('classify samples/astro-app', () => {
  let classification: Classification;

  beforeAll(async () => {
    if (!existsSync(ENTRY)) {
      throw new Error(`${ENTRY} not found — run 'pnpm test:sample:astro' first.`);
    }

    classification = await classify([ENTRY, INSTRUMENT], ROOT);

    writeDebug('classify-astro.json', classification);
  });

  it('classifies sharp as external', () => {
    expect(classification.external).toContain('sharp');
  });

  it('classifies pino as external', () => {
    expect(classification.external).toContain('pino');
  });

  it('classifies @opentelemetry/instrumentation as external', () => {
    expect(classification.external).toContain('@opentelemetry/instrumentation');
  });

  it('pulls require-in-the-middle into the closure', () => {
    expect(classification.external).toContain('require-in-the-middle');
  });

  it('pulls import-in-the-middle into the closure', () => {
    expect(classification.external).toContain('import-in-the-middle');
  });

  // escape-string-regexp is referenced only via literal import.meta.resolve —
  // invisible to nft, recovered by the bundle scan.
  it('classifies escape-string-regexp as external via bundled-external', () => {
    expect(classification.external).toContain('escape-string-regexp');
    expect(classification.reasons.get('escape-string-regexp')).toContain('bundled-external');
  });
});
