/**
 * Throughput / latency micro-benchmark.
 *
 * Usage:
 *   npx ts-node src/example/bench.ts            # default 5000 tasks
 *   TASKS=20000 POOL=8 npx ts-node src/example/bench.ts
 *
 * Reports:
 *   - cold-start time (until pool is ready for first task)
 *   - p50 / p95 / p99 / max round-trip latency
 *   - sustained throughput (tasks / second)
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { WorkerModule } from '../core/worker.module';
import { WorkerService } from '../core/worker.service';
import { ConfigService } from './config.service';
import { ImageService } from './image.service';

const TASKS = Number(process.env.TASKS ?? 5_000);
const POOL = Number(process.env.POOL ?? os.cpus().length);
const WARMUP = Number(process.env.WARMUP ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 508);
const METHOD = process.env.METHOD ?? 'moduleRequire';

@Module({
  imports: [WorkerModule.forRoot({ poolSize: POOL, concurrency: CONCURRENCY, shutdownTimeout: 5_000 })],
  providers: [ConfigService, ImageService],
})
class BenchModule {}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function run(): Promise<void> {
  console.log(`▶ bench: tasks=${TASKS} pool=${POOL} concurrency=${CONCURRENCY} method=${METHOD} warmup=${WARMUP}`);

  const t0 = performance.now();
  const app = await NestFactory.createApplicationContext(BenchModule, { logger: false });
  const ws = app.get(WorkerService);

  // Cold-start: first task forces pool readiness.
  await ws.run('ImageService', METHOD);
  const cold = performance.now() - t0;
  console.log(`  cold-start: ${cold.toFixed(1)} ms`);

  // Warm-up — JIT, MessagePort priming, etc.
  await Promise.all(
    Array.from({ length: WARMUP }, () => ws.run('ImageService', METHOD)),
  );

  // Measured run — uses the cheapest task (cached require) so we measure
  // pool + IPC overhead rather than CPU work.
  const latencies = new Float64Array(TASKS);
  const start = performance.now();

  await Promise.all(
    Array.from({ length: TASKS }, async (_, i) => {
      const t = performance.now();
      await ws.run('ImageService', METHOD);
      latencies[i] = performance.now() - t;
    }),
  );

  const wall = performance.now() - start;
  const sorted = Array.from(latencies).sort((a, b) => a - b);

  console.log(`  wall:       ${wall.toFixed(1)} ms`);
  console.log(`  throughput: ${(TASKS / (wall / 1000)).toFixed(0)} tasks/s`);
  console.log(`  p50:        ${pct(sorted, 50).toFixed(3)} ms`);
  console.log(`  p95:        ${pct(sorted, 95).toFixed(3)} ms`);
  console.log(`  p99:        ${pct(sorted, 99).toFixed(3)} ms`);
  console.log(`  max:        ${sorted[sorted.length - 1].toFixed(3)} ms`);

  await app.close();
}

run().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});


