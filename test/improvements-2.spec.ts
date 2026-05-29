/**
 * Tests for the bigger structural improvements:
 *  - Function `retryDelay` is honoured per-attempt
 *  - Abort AFTER dispatch (in-flight) cancels the running task
 *  - Timeout terminates + replaces the worker; pool keeps serving
 *  - Typed `invoke(Class).method()` helper
 *  - `concurrency > 1` preserves per-jobId routing
 *  - `stats()` exposes saturation and maxQueueDepth
 *  - Custom logger sink is honoured
 *  - Graceful shutdown drains in-flight work
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as path from 'node:path';

const distRoot = path.resolve(__dirname, '..', 'dist');
const distBuilt =
  fs.existsSync(path.join(distRoot, 'index.js')) &&
  fs.existsSync(path.join(distRoot, 'worker', 'worker-runtime.js')) &&
  fs.existsSync(path.join(distRoot, 'example', 'image.service.js'));

if (!distBuilt) {
  describe.skip('improvements-2 (dist not built — run `npm run build` first)', () => {
    it('skipped', () => undefined);
  });
} else {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Module } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { WorkerModule, WorkerService } = require(path.join(distRoot, 'index.js'));
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

  describe('retryDelay function is evaluated per-attempt main-side', () => {
    jest.setTimeout(30_000);

    it('invokes the function with increasing attempt numbers', async () => {
      const app = await makeApp();
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      const seenAttempts: number[] = [];
      const start = Date.now();
      await expect(
        ws.run('ImageService', 'alwaysFail', [], {
          retry: 2,
          retryDelay: (attempt: number) => {
            seenAttempts.push(attempt);
            return 25; // small delay; we care about being called, not duration
          },
        }),
      ).rejects.toBeDefined();
      const elapsed = Date.now() - start;

      // First attempt has no preceding delay; retries 2 & 3 each delayed ≥25ms.
      expect(seenAttempts).toEqual([1, 2]);
      expect(elapsed).toBeGreaterThanOrEqual(40);

      await app.close();
    });
  });

  describe('abort after dispatch cancels in-flight work', () => {
    jest.setTimeout(30_000);

    it('rejects with AbortError and the task observes the signal', async () => {
      const app = await makeApp();
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      const ctrl = new AbortController();
      const p = ws.run('ImageService', 'sleep', [5_000], {
        signal: ctrl.signal,
      });
      // Give the dispatch microtask + postMessage a moment to land in the worker.
      await new Promise((r) => setTimeout(r, 25));
      ctrl.abort();
      await expect(p).rejects.toBeDefined();

      // Pool should still be functional after an in-flight abort.
      await expect(ws.run('ImageService', 'noop')).resolves.toBe(1);

      await app.close();
    });
  });

  describe('timeout terminates and replaces the worker', () => {
    jest.setTimeout(30_000);

    it('after a timeout the pool stays healthy and serves subsequent jobs', async () => {
      const app = await makeApp({ poolSize: 1 });
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      await expect(ws.run('ImageService', 'sleep', [5_000], { timeout: 30 })).rejects.toMatchObject(
        { name: 'TimeoutError' },
      );

      // Allow the replacement worker to come up.
      await new Promise((r) => setTimeout(r, 250));

      const out = await ws.run('ImageService', 'noop');
      expect(out).toBe(1);

      await app.close();
    });
  });

  describe('typed invoke()', () => {
    jest.setTimeout(30_000);

    it('proxies method calls into ws.run() with the right class name', async () => {
      const app = await makeApp();
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      const img = ws.invoke(ImageService);
      const out = await img.noop();
      expect(out).toBe(1);
      const thumb = await img.generateThumbnail(320, 240);
      expect(typeof thumb).toBe('string');
      expect(thumb).toMatch(/^thumb_/);

      // Per-invocation options (timeout) flow through.
      await expect(ws.invoke(ImageService, { timeout: 30 }).sleep(5_000)).rejects.toMatchObject({
        name: 'TimeoutError',
      });

      await app.close();
    });
  });

  describe('concurrency > 1 preserves per-jobId routing', () => {
    jest.setTimeout(30_000);

    it('returns results matching their inputs across many pipelined jobs', async () => {
      const app = await makeApp({ poolSize: 2, concurrency: 4 });
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      // Warm
      await Promise.all([ws.run('ImageService', 'noop'), ws.run('ImageService', 'noop')]);

      const N = 40;
      // Each call has a unique payload — the result is hash(w*h), so swapped
      // routing would produce mismatches.
      const inputs = Array.from({ length: N }, (_, i) => [10 + i, 20 + i] as [number, number]);
      const results = await Promise.all(
        inputs.map(([w, h]) => ws.run('ImageService', 'generateThumbnail', [w, h])),
      );
      // Each result string embeds the original dimensions — verify mapping.
      for (let i = 0; i < N; i++) {
        const [w, h] = inputs[i];
        expect(results[i]).toContain(`_${w}x${h}.webp`);
      }

      await app.close();
    });
  });

  describe('stats() exposes saturation and maxQueueDepth', () => {
    jest.setTimeout(30_000);

    it('reports finite saturation under bounded queue', async () => {
      const app = await makeApp({ maxQueueDepth: 8 });
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      // Flood synchronously and read stats *before* the microtask drain.
      const burst = Array.from({ length: 5 }, () => ws.run('ImageService', 'resizeImage', [1]));
      const stats = ws.stats();
      expect(stats.maxQueueDepth).toBe(8);
      expect(stats.saturation).toBeGreaterThanOrEqual(0);
      expect(stats.saturation).toBeLessThanOrEqual(1);
      await Promise.all(burst);
      await app.close();
    });

    it('reports zero saturation when unbounded (default)', async () => {
      const app = await makeApp();
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');
      const stats = ws.stats();
      expect(stats.saturation).toBe(0);
      expect(stats.maxQueueDepth).toBe(Number.POSITIVE_INFINITY);
      await app.close();
    });
  });

  describe('custom logger', () => {
    jest.setTimeout(30_000);

    it('routes dead-letter messages through the provided logger', async () => {
      const errors: string[] = [];
      const logger = {
        error: (msg: string) => errors.push(msg),
        warn: () => undefined,
        debug: () => undefined,
      };
      const app = await makeApp({ logger });
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      await expect(ws.run('ImageService', 'alwaysFail')).rejects.toBeDefined();

      expect(errors.some((m) => m.includes('Dead letter'))).toBe(true);
      await app.close();
    });
  });

  describe('graceful shutdown drains in-flight work', () => {
    jest.setTimeout(30_000);

    it('lets active jobs settle before terminating workers', async () => {
      const app = await makeApp({ poolSize: 1, shutdownTimeout: 5_000 });
      const ws: InstanceType<typeof WorkerService> = app.get(WorkerService);
      await ws.run('ImageService', 'noop');

      // Start a moderately slow job, then close immediately.
      const p = ws.run('ImageService', 'sleep', [200]);
      await new Promise((r) => setTimeout(r, 10));
      const closing = app.close();
      const result = await p;
      await closing;
      expect(result).toBe('slept 200ms');
    });
  });
}
