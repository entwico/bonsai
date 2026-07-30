import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Pm, type ProbeResult, bootAndProbe, installBuildPrune, prepareSample } from './harness.js';
import { discoverRuntimes } from './runtimes.js';

const SETUP_TIMEOUT = 600_000;

// tsc emits .js entrypoints, so the rewrite flow writes server.mjs alongside them
// while the trace still runs against the originals — both flows boot dist/server.js.
const ENTRYPOINTS = ['dist/server.js', 'dist/worker.js', 'dist/externals.js'];
const ROUTES = ['/', '/playwright'];

const FLOWS = [
  { name: 'rewrite', rewrite: true },
  { name: 'prune', rewrite: false },
] as const;

const PMS: Pm[] = ['pnpm', 'npm'];
const runtimes = discoverRuntimes();

for (const runtime of runtimes) {
  for (const pm of PMS) {
    for (const flow of FLOWS) {
      describe.skipIf(!runtime.available)(`e2e node-app · ${runtime.name} · ${pm} · ${flow.name}`, () => {
        let sample: ReturnType<typeof prepareSample>;
        let probes: ProbeResult[];
        let serverLog = '';

        beforeAll(async () => {
          sample = prepareSample('node-app', pm, runtime);
          installBuildPrune(sample.dir, pm, flow, ENTRYPOINTS);

          const out = await bootAndProbe(sample.dir, [join(sample.dir, 'dist', 'server.js')], ROUTES);

          probes = out.results;
          serverLog = out.log;
        }, SETUP_TIMEOUT);

        afterAll(() => sample?.cleanup());

        for (const route of ROUTES) {
          it(`serves ${route} from the pruned tree`, () => {
            const probe = probes.find((p) => p.route === route)!;

            expect(probe.status, `${route} → ${probe.status}\n${probe.body}\n---server---\n${serverLog}`).toBe(200);
          });
        }

        it('runs the forked worker and the dynamically imported plugin', () => {
          const probe = probes.find((p) => p.route === '/')!;

          expect(probe.body).toContain('"plugin":"foo"');
          expect(probe.body).toContain('Hello from worker');
        });

        it('loads playwright with playwright-core kept whole', () => {
          const probe = probes.find((p) => p.route === '/playwright')!;

          expect(probe.body, probe.body).toContain('"browser":"chromium"');
          expect(probe.body).toContain('"launch":"function"');
        });
      });
    }
  }
}
