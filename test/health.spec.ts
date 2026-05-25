import { WorkerHealthIndicator } from '../src';
import type { PoolStats } from '../src';

function makeIndicator(stats: PoolStats): WorkerHealthIndicator {
  const fake = { stats: () => stats } as never;
  return new WorkerHealthIndicator(fake);
}

describe('WorkerHealthIndicator', () => {
  it('reports "up" when the pool is fully warm and queue is healthy', () => {
    const ind = makeIndicator({
      poolSize: 4,
      idle: 4,
      busy: 0,
      queued: 0,
      warmingUp: 0,
    });
    const result = ind.check('workers');
    expect(result.workers.status).toBe('up');
    expect(result.workers.details.poolSize).toBe(4);
    expect(result.workers.error).toBeUndefined();
  });

  it('throws with warming-up cause when any worker is still warming up', () => {
    const ind = makeIndicator({
      poolSize: 4,
      idle: 2,
      busy: 0,
      queued: 0,
      warmingUp: 2,
    });
    try {
      ind.check('workers');
      fail('expected check() to throw');
    } catch (err) {
      const causes = (err as { causes?: string[] }).causes ?? [];
      const indicator = (
        err as Record<string, { status: string; error?: string }>
      ).workers;
      expect(indicator.status).toBe('down');
      expect(causes[0]).toMatch(/warming up/);
    }
  });

  it('throws when queue depth exceeds pool size (backpressure)', () => {
    const ind = makeIndicator({
      poolSize: 4,
      idle: 0,
      busy: 4,
      queued: 100,
      warmingUp: 0,
    });
    try {
      ind.check('workers');
      fail('expected check() to throw');
    } catch (err) {
      const indicator = (
        err as Record<string, { status: string; error?: string }>
      ).workers;
      expect(indicator.status).toBe('down');
      expect(indicator.error).toMatch(/Queue depth/);
    }
  });
});
