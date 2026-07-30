import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NodeRuntime, childEnv } from './runtimes.js';

export type Pm = 'pnpm' | 'npm';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repoRoot, 'dist', 'cli.mjs');

const SAMPLE_SOURCES = ['package.json', 'astro.config.mjs', 'tsconfig.json', '.npmrc', 'pnpm-workspace.yaml', 'src'];
const LOCKFILES: Record<Pm, string> = { pnpm: 'pnpm-lock.yaml', npm: 'package-lock.json' };
// hoisted matches what `bonsai install` forces (and the real Docker layout): every
// transitive dep gets a top-level node_modules entry, which the prune's package lookups rely on.
const INSTALL_ARGS: Record<Pm, string[]> = {
  pnpm: ['install', '--frozen-lockfile', '--node-linker=hoisted'],
  npm: ['ci'],
};

export interface PreparedSample {
  dir: string;
  cleanup: () => void;
}

// isolated copy of a sample: sources + the chosen package manager's lockfile. a .prototools
// pins the node version so every pnpm/npm/node call in this dir resolves the same runtime.
export function prepareSample(sampleName: string, pm: Pm, runtime: NodeRuntime): PreparedSample {
  const src = join(repoRoot, 'samples', sampleName);
  const dir = mkdtempSync(join(tmpdir(), `nft-e2e-${sampleName}-${pm}-`));

  for (const entry of SAMPLE_SOURCES) {
    const from = join(src, entry);

    if (existsSync(from)) cpSync(from, join(dir, entry), { recursive: true });
  }

  cpSync(join(src, LOCKFILES[pm]), join(dir, LOCKFILES[pm]));

  if (runtime.version) writeFileSync(join(dir, '.prototools'), `node = "${runtime.version}"\n`);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, env: childEnv(), stdio: 'inherit', timeout: 600_000 });
}

export interface FlowSpec {
  rewrite: boolean;
}

// install + build, then trace-and-prune. rewrite is bonsai's default and emits the bundled
// entrypoints via rolldown, turning CJS requires into the __require NFT can't see;
// --no-rewrite is the trace-only path.
export function installBuildPrune(sampleDir: string, pm: Pm, flow: FlowSpec, entrypoints: string[]): void {
  run(pm, INSTALL_ARGS[pm], sampleDir);
  run(pm, ['run', 'build'], sampleDir);

  const args = [cli, 'prune'];

  if (!flow.rewrite) args.push('--no-rewrite');

  args.push(...entrypoints);

  run('node', args, sampleDir);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();

    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;

      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();

        if (Date.now() > deadline) reject(new Error(`server never opened port ${port}`));
        else setTimeout(attempt, 150);
      });
    };

    attempt();
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = net.connect({ host: '127.0.0.1', port }, () => {
      req.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });

    let raw = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const status = Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);

      resolve({ status, body });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`request to ${path} timed out`));
    });
  });
}

export interface ProbeResult {
  route: string;
  status: number;
  body: string;
}

// boots `node <nodeArgs>` in the pruned sample dir and probes the routes.
// a pruned-away package surfaces as a boot crash or a 5xx.
export async function bootAndProbe(
  sampleDir: string,
  nodeArgs: string[],
  routes: string[],
): Promise<{ results: ProbeResult[]; log: string }> {
  const port = await freePort();

  const child = spawn('node', nodeArgs, {
    cwd: sampleDir,
    env: childEnv({ HOST: '127.0.0.1', PORT: String(port) }) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';

  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited early (code ${code})\n${log}`)));
  });

  try {
    await Promise.race([waitForPort(port, 30_000), exited]);

    const results: ProbeResult[] = [];

    for (const route of routes) {
      const { status, body } = await httpGet(port, route);

      results.push({ route, status, body });
    }

    return { results, log };
  } finally {
    child.kill('SIGKILL');
  }
}
