import { readFile } from 'node:fs/promises';
import { type NodeFileTraceOptions, type NodeFileTraceResult, nodeFileTrace, resolve as resolveDependency } from '@vercel/nft';

type ResolveHook = NonNullable<NodeFileTraceOptions['resolve']>;

async function sourceUsesCreateRequire(file: string): Promise<boolean> {
  try {
    const source = await readFile(file, 'utf8');

    return source.includes('createRequire');
  } catch {
    return false;
  }
}

async function tryResolve(...args: Parameters<typeof resolveDependency>): Promise<string | string[] | null> {
  try {
    return await resolveDependency(...args);
  } catch {
    return null;
  }
}

// nft resolves every dependency of an esm file under the `import` condition, including
// the require() calls it recognizes from `createRequire`. node resolves those under
// `require`, so a dual-condition `exports`/`imports` target ends up traced as the .mjs
// variant while the runtime loads the .cjs one. for parents that use createRequire,
// resolve under both conditions and keep both targets.
function createResolveHook(): ResolveHook {
  const usesCreateRequire = new Map<string, Promise<boolean>>();

  const parentUsesCreateRequire = (parent: string): Promise<boolean> => {
    let pending = usesCreateRequire.get(parent);

    if (!pending) {
      pending = sourceUsesCreateRequire(parent);
      usesCreateRequire.set(parent, pending);
    }

    return pending;
  };

  return async (id, parent, job, cjsResolve) => {
    const resolved = await resolveDependency(id, parent, job, cjsResolve);

    if (cjsResolve || !(await parentUsesCreateRequire(parent))) {
      return resolved;
    }

    const cjsResolved = await tryResolve(id, parent, job, true);

    if (cjsResolved === null) {
      return resolved;
    }

    return [...new Set([resolved, cjsResolved].flat())];
  };
}

export function trace(files: string[], cwd: string): Promise<NodeFileTraceResult> {
  return nodeFileTrace(files, { base: cwd, resolve: createResolveHook() });
}
