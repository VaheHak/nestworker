// Module
export { WorkerModule } from './core/worker.module';

// Services
export { WorkerService } from './core/worker.service';
export type { RunOptions } from './core/worker.service';

// Decorators
export { WorkerClass, WorkerTask } from './decorators/worker-task.decorator';
export type { WorkerTaskOptions } from './decorators/worker-task.decorator';

// Health
export { WorkerHealthIndicator } from './health/worker.health';
export type { WorkerHealthResult } from './health/worker.health';

// Metrics
export { WorkerMetricsService } from './metrics/worker.metrics';
export type { WorkerMetricsSnapshot } from './metrics/worker.metrics';

// Types
export type {
  WorkerJob,
  WorkerModuleOptions,
  WorkerModuleAsyncOptions,
  TaskPriority,
  DeadLetterEvent,
  PoolStats,
  SerializedError,
} from './core/worker.interfaces';
