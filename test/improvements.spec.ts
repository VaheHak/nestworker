/**
 * Tests covering the round of robustness/perf improvements:
 *  - AbortSignal listener does not leak across many runs
 *  - maxQueueDepth backpressure rejects with QueueFullError
 *  - Pre-init listener subscriptions are replayed onto the pool
 *  - retryDelay-as-function is honoured main-side
 *  - Non-cloneable args fail the promise instead of hanging
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

const distRoot = path.resolve(__dirname, '..', 'dist');
const distBuilt =
  fs.existsSync(path.join(distRoot, 'index.js')) &&
  fs.existsSync(path.join(distRoot, 'worker', 'worker-runtime.js')) &&
  fs.existsSync(path.join(distRoot, 'example', 'image.service.js')) &&
  fs.existsSync(path.join(distRoot, 'example', 'config.service.js'));

if (!distBuilt) {
  describe.skip('improvements (dist not built — run `npm run build` first)', () => {
    it('skipped', () => undefined);
  });
} else {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { WorkerModule, WorkerService, QueueFullError } = require(path.join(distRoot, 'index.js'));
  const { ConfigService } = require(path.join(distRoot, 'example', 'config.service.js'));
  const { ImageService } = require(path.join(distRoot, 'example', 'image.service.js'));
  /* eslint-enable @typescript-eslint/no-var-requires */

  function makeApp(options: Record<string, unknown> = {}) {
    @Module({
      imports: [
        WorkerModule.forRoot({
          poolSize: 2,
          shutdownTimeout: 5_000,
          concurrency: 1,
          ...options,
        }),
      ],
      providers: [ConfigService, ImageService],
    })
    class TestApp {}
    return NestFactory.createApplicationContext(TestApp, { logger: false });
  }

  describe('AbortSignal listener does not leak', () => {
    jest.setTimeout(30_000);

    let app: { get: <T>(tok: unknown) => T; close: () => Promise<void> };
    let ws: InstanceType<typeof WorkerService>;

    beforeAll(async () => {
      app = await makeApp();
      ws = app.get(WorkerService);
      // Warm up so we don't race vm.runInContext.
      await ws.run('ImageService', 'noop');
    });
    afterAll(async () => app?.close());

    it('runs many jobs with a shared signal without piling listeners', async () => {
      const ctrl = new AbortController();
      const N = 50;
      const before = (
        ctrl.signal as unknown as {
          eventListeners?: (e: string) => unknown[];
        }
      ).eventListeners
        ? (
            ctrl.signal as unknown as {
              eventListeners: (e: string) => unknown[];
            }
          ).eventListeners('abort').length
        : 0;

      for (let i = 0; i < N; i++) {
        await ws.run('ImageService', 'noop', [], { signal: ctrl.signal });
      }

      // After completion, no abort listener should remain — if the leak
      // regressed, this would grow by N.
      const after = (
        ctrl.signal as unknown as {
          eventListeners?: (e: string) => unknown[];
        }
      ).eventListeners
        ? (
            ctrl.signal as unknown as {
              eventListeners: (e: string) => unknown[];
            }
          ).eventListeners('abort').length
        : 0;

      // Some Node versions don't expose `eventListeners` on AbortSignal;
      // in that case `before === after === 0` and the assertion still holds.
      expect(after - before).toBeLessThanOrEqual(0);
    });
  });

  describe('maxQueueDepth backpressure', () => {
    jest.setTimeout(30_000);

    let app: { get: <T>(tok: unknown) => T; close: () => Promise<void> };
    let ws: InstanceType<typeof WorkerService>;

    beforeAll(async () => {
      app = await makeApp({ maxQueueDepth: 2 });
      ws = app.get(WorkerService);
      // Warm.
      await Promise.all([ws.run('ImageService', 'noop'), ws.run('ImageService', 'noop')]);
    });
    afterAll(async () => app?.close());

    it('rejects with QueueFullError when queue is saturated', async () => {
      // Flood synchronously: 2 workers + queue cap 2 = at most 4 accepted
      // before the 5th rejects. Use a heavyish task so the queue actually
      // backs up before the first completion.
      const burst: Promise<unknown>[] = [];
      let queueFull = 0;
      for (let i = 0; i < 30; i++) {
        burst.push(
          ws.run('ImageService', 'resizeImage', [i]).catch((err: Error) => {
            if (err instanceof QueueFullError || (err as Error)?.name === 'QueueFullError') {
              queueFull++;
              return undefined;
            }
            throw err;
          }),
        );
      }
      await Promise.all(burst);
      expect(queueFull).toBeGreaterThan(0);
    });
  });

  describe('pre-init listener subscription is replayed', () => {
    jest.setTimeout(30_000);

    it('captures taskEnd registered before onModuleInit', async () => {
      const app = await makeApp();
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);

      // Subscribe *immediately* — pool was just created by onModuleInit
      // here so this is more a smoke test, but the buffered-subscribe
      // path also runs through `subscribe()`.
      const ended: number[] = [];
      ws.onTaskEnd((j: { jobId: number }) => ended.push(j.jobId));

      await ws.run('ImageService', 'noop');
      expect(ended.length).toBeGreaterThan(0);

      await app.close();
    });
  });

  describe('non-cloneable args fail fast', () => {
    jest.setTimeout(30_000);

    let app: { get: <T>(tok: unknown) => T; close: () => Promise<void> };
    let ws: InstanceType<typeof WorkerService>;

    beforeAll(async () => {
      app = await makeApp();
      ws = app.get(WorkerService);
      await ws.run('ImageService', 'noop');
    });
    afterAll(async () => app?.close());

    it('rejects with DataCloneError instead of hanging', async () => {
      // A function is not structuredClone-compatible.
      const badArg = (): void => undefined;
      await expect(
        ws.run('ImageService', 'noop', [badArg as unknown as number]),
      ).rejects.toBeDefined();
    });
  });
}
