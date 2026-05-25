import { EventEmitter } from 'node:events';
import { WorkerMetricsService } from '../src';
import type { PoolStats, SerializedError, WorkerJob } from '../src';

/**
 * Minimal stand-in for WorkerService that the metrics service binds to.
 * WorkerMetricsService only uses `onTaskStart/End/Error`, `onDead`, `stats()`.
 */
class FakeWorkerService extends EventEmitter {
  public statsValue: PoolStats = {
    poolSize: 4,
    idle: 4,
    busy: 0,
    queued: 0,
    warmingUp: 0,
  };
  onTaskStart(l: (job: WorkerJob) => void) {
    this.on('taskStart', l);
    return this;
  }
  onTaskEnd(l: (job: WorkerJob, durationMs: number) => void) {
    this.on('taskEnd', l);
    return this;
  }
  onTaskError(l: (job: WorkerJob, err: SerializedError) => void) {
    this.on('taskError', l);
    return this;
  }
  onDead(l: () => void) {
    this.on('dead', l);
    return this;
  }
  stats(): PoolStats {
    return this.statsValue;
  }
}

const job = (svc: string, m: string, id = 1): WorkerJob => ({
  jobId: id,
  serviceName: svc,
  methodName: m,
  args: [],
});

describe('WorkerMetricsService', () => {
  let fake: FakeWorkerService;
  let metrics: WorkerMetricsService;

  beforeEach(() => {
    fake = new FakeWorkerService();
    metrics = new WorkerMetricsService(fake as never);
    metrics.onModuleInit();
  });

  afterEach(() => {
    metrics.onModuleDestroy();
  });

  it('counts task lifecycle events', () => {
    fake.emit('taskStart', job('Img', 'a'));
    fake.emit('taskStart', job('Img', 'a', 2));
    fake.emit('taskEnd', job('Img', 'a'), 10);
    fake.emit('taskError', job('Img', 'a', 2), {
      name: 'Error',
      message: 'boom',
    });
    fake.emit('dead', { jobId: 2 });

    const snap = metrics.snapshot();
    expect(snap.jobsTotal).toBe(2);
    expect(snap.jobsSuccess).toBe(1);
    expect(snap.jobsFailed).toBe(1);
    expect(snap.jobsDead).toBe(1);
    expect(snap.jobsTimeout).toBe(0);
  });

  it('separates timeouts from generic failures', () => {
    fake.emit('taskError', job('S', 'm'), {
      name: 'TimeoutError',
      message: 't',
    });
    fake.emit('taskError', job('S', 'm'), { name: 'Error', message: 'x' });

    const snap = metrics.snapshot();
    expect(snap.jobsFailed).toBe(2);
    expect(snap.jobsTimeout).toBe(1);
  });

  it('computes per-task duration percentiles', () => {
    const j = job('Img', 'resize');
    for (let i = 1; i <= 100; i++) fake.emit('taskEnd', j, i);

    const snap = metrics.snapshot();
    const d = snap.durations['Img.resize'];
    expect(d.count).toBe(100);
    expect(d.p50).toBe(50);
    expect(d.p95).toBe(95);
    expect(d.p99).toBe(99);
  });

  it('exposes live pool stats through snapshot', () => {
    fake.statsValue = {
      poolSize: 8,
      idle: 3,
      busy: 5,
      queued: 12,
      warmingUp: 0,
    };
    const snap = metrics.snapshot();
    expect(snap.queueDepth).toBe(12);
    expect(snap.idleWorkers).toBe(3);
    expect(snap.busyWorkers).toBe(5);
  });

  it('reset() zeros all counters and clears samples', () => {
    fake.emit('taskStart', job('S', 'm'));
    fake.emit('taskEnd', job('S', 'm'), 42);
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.jobsTotal).toBe(0);
    expect(snap.jobsSuccess).toBe(0);
    expect(Object.keys(snap.durations)).toHaveLength(0);
  });
});
