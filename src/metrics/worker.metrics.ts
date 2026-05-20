import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WorkerService } from '../core/worker.service';
import type { WorkerJob, SerializedError } from '../core/worker.interfaces';

export interface WorkerMetricsSnapshot {
  /** Total jobs dispatched since startup */
  jobsTotal: number;
  /** Jobs that completed successfully */
  jobsSuccess: number;
  /** Jobs that failed (after all retries) */
  jobsFailed: number;
  /** Jobs that timed out */
  jobsTimeout: number;
  /** Jobs sent to dead letter queue */
  jobsDead: number;
  /** Current queue depth */
  queueDepth: number;
  /** Current idle worker count */
  idleWorkers: number;
  /** Current busy worker count */
  busyWorkers: number;
  /** Per-task duration histogram (p50, p95, p99) in ms */
  durations: Record<string, { p50: number; p95: number; p99: number; count: number }>;
}

/**
 * WorkerMetricsService — collects runtime metrics from the worker pool.
 *
 * Designed to be framework-agnostic: read the snapshot and push to
 * Prometheus, Datadog, CloudWatch, or any other metrics provider.
 *
 * @example
 *   // Prometheus integration
 *   @Get('metrics')
 *   async metrics() {
 *     const snap = this.workerMetrics.snapshot();
 *     return [
 *       `nestworker_jobs_total ${snap.jobsTotal}`,
 *       `nestworker_jobs_success ${snap.jobsSuccess}`,
 *       `nestworker_queue_depth ${snap.queueDepth}`,
 *     ].join('\n');
 *   }
 */
@Injectable()
export class WorkerMetricsService implements OnModuleInit, OnModuleDestroy {
  private jobsTotal    = 0;
  private jobsSuccess  = 0;
  private jobsFailed   = 0;
  private jobsTimeout  = 0;
  private jobsDead     = 0;

  /** Raw duration samples per task key — capped at 1000 samples */
  private readonly durationSamples = new Map<string, number[]>();

  /** Interval handle for periodic pool-stats polling */
  private statsInterval?: NodeJS.Timeout;

  constructor(private readonly workerService: WorkerService) {}

  onModuleInit(): void {
    // Task start
    this.workerService.onTaskStart((job: WorkerJob) => {
      this.jobsTotal++;
    });

    // Task end: record duration + success
    this.workerService.onTaskEnd((job: WorkerJob, durationMs: number) => {
      const key = `${job.serviceName}.${job.methodName}`;
      this.jobsSuccess++;
      this.pushDuration(key, durationMs);
    });

    // Task error: record failure
    this.workerService.onTaskError((job: WorkerJob, error: SerializedError) => {
      this.jobsFailed++;
      if (error.name === 'TimeoutError') this.jobsTimeout++;
    });

    // Dead letter: separate counter
    this.workerService.onDead(() => {
      this.jobsDead++;
    });
  }

  onModuleDestroy(): void {
    if (this.statsInterval) clearInterval(this.statsInterval);
  }

  /** Returns a point-in-time snapshot of all metrics */
  snapshot(): WorkerMetricsSnapshot {
    const stats = this.workerService.stats();
    const durations: WorkerMetricsSnapshot['durations'] = {};

    for (const [key, samples] of this.durationSamples) {
      durations[key] = computePercentiles(samples);
    }

    return {
      jobsTotal:   this.jobsTotal,
      jobsSuccess: this.jobsSuccess,
      jobsFailed:  this.jobsFailed,
      jobsTimeout: this.jobsTimeout,
      jobsDead:    this.jobsDead,
      queueDepth:  stats.queued,
      idleWorkers: stats.idle,
      busyWorkers: stats.busy,
      durations,
    };
  }

  /** Reset all counters (useful in tests) */
  reset(): void {
    this.jobsTotal = this.jobsSuccess = this.jobsFailed =
      this.jobsTimeout = this.jobsDead = 0;
    this.durationSamples.clear();
  }

  private pushDuration(key: string, ms: number): void {
    if (!this.durationSamples.has(key)) this.durationSamples.set(key, []);
    const samples = this.durationSamples.get(key)!;
    samples.push(ms);
    // Keep memory bounded — reservoir sampling after 1000 entries
    if (samples.length > 1000) {
      const idx = Math.floor(Math.random() * samples.length);
      samples.splice(idx, 1);
    }
  }
}

function computePercentiles(
  samples: number[],
): { p50: number; p95: number; p99: number; count: number } {
  if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (pct: number) => sorted[Math.ceil((pct / 100) * sorted.length) - 1] ?? 0;
  return { p50: p(50), p95: p(95), p99: p(99), count: samples.length };
}
