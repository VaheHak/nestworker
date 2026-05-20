import { Injectable } from '@nestjs/common';
import { WorkerService } from '../core/worker.service';

export interface WorkerHealthResult {
  status: 'up' | 'down';
  details: {
    poolSize: number;
    idle: number;
    busy: number;
    queued: number;
    warmingUp: number;
  };
  error?: string;
}

/**
 * WorkerHealthIndicator — plugs into NestJS Terminus.
 *
 * @example
 *   // health.controller.ts
 *   import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
 *   import { WorkerHealthIndicator } from 'nestworker';
 *
 *   @Controller('health')
 *   export class HealthController {
 *     constructor(
 *       private health: HealthCheckService,
 *       private workerHealth: WorkerHealthIndicator,
 *     ) {}
 *
 *     @Get()
 *     @HealthCheck()
 *     check() {
 *       return this.health.check([
 *         () => this.workerHealth.check('workers'),
 *       ]);
 *     }
 *   }
 */
@Injectable()
export class WorkerHealthIndicator {
  constructor(private readonly workerService: WorkerService) {}

  /**
   * Returns a Terminus-compatible health indicator result.
   * Reports 'down' when warmingUp > 0 (pool not fully ready) or when
   * queued jobs exceed the pool size (backpressure signal).
   */
  check(key: string): Record<string, WorkerHealthResult> {
    const stats = this.workerService.stats();
    const isDown =
      stats.warmingUp > 0 ||
      stats.queued > stats.poolSize;

    const result: WorkerHealthResult = {
      status: isDown ? 'down' : 'up',
      details: stats,
      ...(isDown && stats.warmingUp > 0
        ? { error: `${stats.warmingUp} worker(s) still warming up` }
        : {}),
      ...(isDown && stats.queued > stats.poolSize
        ? { error: `Queue depth (${stats.queued}) exceeds pool size (${stats.poolSize})` }
        : {}),
    };

    if (isDown) {
      throw Object.assign(new Error(`Worker pool unhealthy`), {
        [key]: result,
        causes: [result.error],
      });
    }

    return { [key]: result };
  }
}
