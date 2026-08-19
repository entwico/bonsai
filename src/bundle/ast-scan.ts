import { readFileSync } from 'node:fs';
import { Parser } from 'acorn';
import { simple } from 'acorn-walk';
import type { DetectReason } from './types';

// substring pre-filter — files lacking any of these never get parsed.
const MARKERS = [
  'new Worker',
  'child_process',
  'Module.register',
  'new Function',
  'eval(',
  'require(',
  'import(',
  'import-in-the-middle',
  'require-in-the-middle',
  'shimmer',
  'thread-stream',
  'piscina',
  'workerpool',
  'import.meta.resolve',
];

// importing/requiring any of these signals that the consuming package
// patches Node's module loader at runtime.
const LOADER_PATCHERS = new Set(['import-in-the-middle', 'require-in-the-middle', 'shimmer']);

// importing/requiring any of these signals that the consuming package
// spawns a worker thread, typically with a sibling file as the entry.
const WORKER_SPAWNERS = new Set(['thread-stream', 'piscina', 'workerpool']);

const CHILD_PROCESS_SPECIFIER = /^(?:node:)?child_process$/;

// a plain string literal, or the zero-expression template literal minifiers turn it into
function literalString(node: any): string | null {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;

  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    const cooked = node.quasis[0]?.value?.cooked;

    return typeof cooked === 'string' ? cooked : null;
  }

  return null;
}

// matches the callee of `import.meta.resolve(...)` — a MemberExpression
// whose object is the `import.meta` MetaProperty.
function isImportMetaResolve(callee: any): boolean {
  return (
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property?.type === 'Identifier' &&
    callee.property.name === 'resolve' &&
    callee.object?.type === 'MetaProperty' &&
    callee.object.meta?.name === 'import' &&
    callee.object.property?.name === 'meta'
  );
}

function reasonForSpecifier(name: string): DetectReason | null {
  if (LOADER_PATCHERS.has(name)) return 'ast-loader-patch';
  if (WORKER_SPAWNERS.has(name)) return 'ast-worker';

  return null;
}

interface ChildProcessBindings {
  // names that, when called as `name(...)`, mean child_process.fork
  directFork: Set<string>;
  // names that, when accessed as `name.fork(...)`, mean child_process.fork
  namespace: Set<string>;
}

// pre-pass: collect identifiers bound to `child_process` (or any of its members
// of interest). this lets us distinguish child_process.fork() from the false positives
function collectChildProcessBindings(ast: any): ChildProcessBindings {
  const bindings: ChildProcessBindings = { directFork: new Set(), namespace: new Set() };

  simple(ast, {
    ImportDeclaration(node: any) {
      const src = node.source?.value;

      if (typeof src !== 'string' || !CHILD_PROCESS_SPECIFIER.test(src)) return;

      const specifiers = node.specifiers ?? [];

      for (const spec of specifiers) {
        if (spec.type === 'ImportSpecifier') {
          const imported = spec.imported?.name ?? spec.imported?.value;

          if (imported === 'fork') bindings.directFork.add(spec.local.name);
        } else if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') {
          bindings.namespace.add(spec.local.name);
        }
      }
    },

    VariableDeclarator(node: any) {
      const init = node.init;

      if (!init || init.type !== 'CallExpression') return;
      if (init.callee?.type !== 'Identifier' || init.callee.name !== 'require') return;

      const spec = literalString(init.arguments?.[0]);

      if (spec === null || !CHILD_PROCESS_SPECIFIER.test(spec)) {
        return;
      }

      if (node.id.type === 'Identifier') {
        bindings.namespace.add(node.id.name);
      } else if (node.id.type === 'ObjectPattern') {
        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;

          const keyName = prop.key?.name ?? prop.key?.value;

          if (keyName !== 'fork') continue;

          const localName = prop.value?.type === 'Identifier' ? prop.value.name : keyName;

          bindings.directFork.add(localName);
        }
      }
    },
  });

  return bindings;
}

// bare specifiers a bundled chunk pulls in via require()/__require() or literal
// import.meta.resolve(). rolldown inlines CJS requires as __require(...) helper calls
// that NFT doesn't treat as import edges, and NFT's evaluator doesn't model
// import.meta.resolve at all — even with a literal argument.
export function scanBundleExternals(path: string): string[] {
  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  // `require(` is a substring of `__require(`, so this pre-filter covers both.
  if (!source.includes('require(') && !source.includes('import.meta.resolve')) return [];

  let ast;

  try {
    ast = Parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    try {
      ast = Parser.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      });
    } catch {
      return [];
    }
  }

  const specifiers = new Set<string>();

  simple(ast, {
    CallExpression(node: any) {
      const callee = node.callee;
      const isRequire = callee?.type === 'Identifier' && (callee.name === 'require' || callee.name === '__require');

      if (!isRequire && !isImportMetaResolve(callee)) return;

      const spec = literalString(node.arguments?.[0]);

      if (spec !== null) specifiers.add(spec);
    },
  });

  return [...specifiers];
}

export function scanFile(path: string): DetectReason[] {
  let source: string;

  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  if (MARKERS.every((m) => !source.includes(m))) return [];

  let ast;

  try {
    ast = Parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
    });
  } catch {
    try {
      ast = Parser.parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      });
    } catch {
      return [];
    }
  }

  const reasons = new Set<DetectReason>();
  const cpBindings = collectChildProcessBindings(ast);

  simple(ast, {
    NewExpression(node: any) {
      const callee = node.callee;

      if (!callee) return;

      if (callee.type === 'Identifier' && callee.name === 'Worker') {
        reasons.add('ast-worker');
      }

      if (callee.type === 'MemberExpression' && callee.property?.name === 'Worker') {
        reasons.add('ast-worker');
      }

      if (callee.type === 'Identifier' && callee.name === 'Function') {
        reasons.add('ast-eval');
      }
    },

    CallExpression(node: any) {
      const callee = node.callee;

      if (!callee) return;

      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'fork' &&
        callee.object?.type === 'Identifier' &&
        cpBindings.namespace.has(callee.object.name)
      ) {
        reasons.add('ast-fork');
      }

      if (callee.type === 'Identifier' && cpBindings.directFork.has(callee.name)) {
        reasons.add('ast-fork');
      }

      if (
        callee.type === 'MemberExpression' &&
        callee.object?.name === 'Module' &&
        callee.property?.name === 'register'
      ) {
        reasons.add('ast-module-register');
      }

      if (callee.type === 'Identifier' && callee.name === 'require') {
        const arg = node.arguments?.[0];

        if (!arg) return;

        const spec = literalString(arg);

        if (spec !== null) {
          const r = reasonForSpecifier(spec);

          if (r) reasons.add(r);
        } else if (arg.type !== 'TemplateLiteral') {
          reasons.add('ast-dyn-require');
        }
      }

      if (callee.type === 'Identifier' && callee.name === 'eval') {
        reasons.add('ast-eval');
      }

      // import.meta.resolve resolves against the calling file's on-disk location,
      // which bundling relocates — and NFT never follows it, literal or not.
      if (isImportMetaResolve(callee)) {
        reasons.add('ast-import-meta-resolve');
      }
    },

    // acorn 8 emits dynamic import() as ImportExpression with `source`,
    // not as CallExpression with callee.type === 'Import'.
    ImportExpression(node: any) {
      const arg = node.source;

      if (!arg) return;

      const spec = literalString(arg);

      if (spec !== null) {
        const r = reasonForSpecifier(spec);

        if (r) reasons.add(r);
      } else if (arg.type !== 'TemplateLiteral') {
        reasons.add('ast-dyn-import');
      }
    },

    ImportDeclaration(node: any) {
      const src = node.source?.value;

      if (typeof src !== 'string') return;

      const r = reasonForSpecifier(src);

      if (r) reasons.add(r);
    },

    ExportAllDeclaration(node: any) {
      const src = node.source?.value;

      if (typeof src !== 'string') return;

      const r = reasonForSpecifier(src);

      if (r) reasons.add(r);
    },

    ExportNamedDeclaration(node: any) {
      const src = node.source?.value;

      if (typeof src !== 'string') return;

      const r = reasonForSpecifier(src);

      if (r) reasons.add(r);
    },
  });

  return [...reasons];
}
