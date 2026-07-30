// packages that static analysis alone gets wrong — each stays external for a
// different reason. this file is never executed by the sample; it exists so the
// trace closure reaches these packages and the classifier has to decide on them.

// browser automation: playwright-core dynamic-requires its driver and references
// browser binaries via computed paths. untraceable — must stay external wholesale.
import { chromium } from 'playwright';

// driver with optional native peers (kerberos, mongodb-client-encryption, snappy,
// @mongodb-js/zstd) it require()s inside try/catch. the resolver must tolerate the
// ones that aren't installed instead of dropping mongodb itself.
import { MongoClient } from 'mongodb';

// pulls fontkit (brotli/unicode data files) and yoga-layout (wasm base64-inlined
// into js). large closure that the trace must carry intact.
import { Font } from '@react-pdf/renderer';
import * as fontkit from 'fontkit';

// requires its component modules by computed name — classic ast-dyn-require.
import mjml2html from 'mjml';

// referenced only through literal import.meta.resolve — no import edge exists,
// so only the bundle scan can keep it.
export const resolvedUrl = import.meta.resolve('escape-string-regexp');

export const externals = {
  chromium,
  MongoClient,
  Font,
  fontkit,
  mjml2html,
};
