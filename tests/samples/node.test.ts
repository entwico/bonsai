import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../../src/bundle/classify';
import type { Classification } from '../../src/bundle/types';
import { writeDebug } from '../util/debug.js';

const ROOT = join(import.meta.dirname, '..', '..', 'samples', 'node-app');
const SERVER = join(ROOT, 'dist', 'server.js');
const WORKER = join(ROOT, 'dist', 'worker.js');
const EXTERNALS = join(ROOT, 'dist', 'externals.js');

describe('classify samples/node-app', () => {
  let classification: Classification;

  beforeAll(async () => {
    if (!existsSync(SERVER)) {
      throw new Error(`${SERVER} not found — run 'pnpm test:sample:node' first.`);
    }

    classification = await classify([SERVER, WORKER, EXTERNALS], ROOT);

    writeDebug('classify-node.json', classification);
  });

  it('runs the full classify pipeline against the built node-app', () => {
    expect(classification.external).toBeInstanceOf(Set);
  });

  // playwright-core dynamic-requires its driver, spawns workers, and references
  // browser binaries via computed paths — untraceable, stays external.
  it('classifies playwright-core as external', () => {
    expect(classification.external).toContain('playwright-core');
    expect(classification.reasons.get('playwright-core')).toContain('ast-dyn-require');
  });

  // the `playwright` wrapper only re-exports playwright-core; it bundles cleanly.
  it('bundles the playwright wrapper (only playwright-core externalizes)', () => {
    expect(classification.external).not.toContain('playwright');
  });

  // mongodb require()s optional native peers (kerberos, mongodb-client-encryption,
  // snappy, @mongodb-js/zstd) in try/catch; nft warns on the ones not installed and
  // mongodb must stay external without the missing peers breaking classification.
  it('classifies mongodb as external via nft-warning', () => {
    expect(classification.external).toContain('mongodb');
    expect(classification.reasons.get('mongodb')).toContain('nft-warning');
  });

  // @react-pdf/renderer itself is ESM-clean and bundles; the untraceable piece in
  // its closure is yoga-layout (loads its wasm through a require nft can't follow).
  it('classifies yoga-layout as external', () => {
    expect(classification.external).toContain('yoga-layout');
  });

  it('bundles @react-pdf/renderer and fontkit (only yoga-layout externalizes)', () => {
    expect(classification.external).not.toContain('@react-pdf/renderer');
    expect(classification.external).not.toContain('fontkit');
  });

  // mjml-core require()s its component modules by computed name — ast-dyn-require.
  it('classifies mjml-core as external via ast-dyn-require', () => {
    expect(classification.external).toContain('mjml-core');
    expect(classification.reasons.get('mjml-core')).toContain('ast-dyn-require');
  });

  it('bundles the mjml wrapper (only mjml-core externalizes)', () => {
    expect(classification.external).not.toContain('mjml');
  });

  // escape-string-regexp is referenced only via literal import.meta.resolve —
  // invisible to nft, recovered by the bundle scan.
  it('classifies escape-string-regexp as external via bundled-external', () => {
    expect(classification.external).toContain('escape-string-regexp');
    expect(classification.reasons.get('escape-string-regexp')).toContain('bundled-external');
  });
});
