import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {WorkerPool} from './worker.pool';
import {WorkerDiscoveryService} from '../discovery/discovery.service';
import {serializeForWorker} from '../di/di-serializer';
import type {TaskPriority, WorkerModuleOptions} from './worker.interfaces';

/**
 * WorkerService
 *
 * Main entry point for executing worker-thread tasks.
 *
 * Features:
 * - Lazy worker pool initialization
 * - Automatic worker discovery
 * - Priority queue support
 * - Timeout support
 * - Worker thread execution
 * - NestJS dependency integration
 *
 * Lifecycle:
 * 1. Discovers worker-enabled services
 * 2. Serializes metadata for worker runtime
 * 3. Creates WorkerPool
 * 4. Dispatches tasks to workers
 * 5. Handles graceful shutdown
 *
 * Example:
 *
 * ```ts
 * await workerService.run(
 *   'ImageService',
 *   'resizeImage',
 *   [500],
 *   {
 *     priority: 'HIGH',
 *     timeout: 5000,
 *   },
 * );
 * ```
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private pool: WorkerPool | null = null;
  private readonly taskOptions = new Map<
    string,
    {
      priority: TaskPriority;
      timeout?: number;
    }
  >();

  constructor(
    private readonly discovery: WorkerDiscoveryService,
    @Inject('WORKER_OPTIONS')
    private readonly options: WorkerModuleOptions,
  ) {
  }

  onModuleInit(): void {
    this.initPool();
  }

  private initPool(): void {
    if (this.pool) return;

    const tasks = this.discovery.scan();

    for (const task of tasks) {
      this.taskOptions.set(
        `${task.serviceName}.${task.methodName}`,
        {priority: task.priority, timeout: task.timeout},
      );
    }

    const serialized = serializeForWorker(tasks);

    this.pool = new WorkerPool(serialized, this.options.poolSize);
  }

  /**
   * Executes a worker task.
   *
   * Parameters:
   * - serviceName: target service
   * - methodName: target method
   * - args: serialized arguments
   * - overrides: runtime priority/timeout overrides
   *
   * Priority:
   * - HIGH
   * - NORMAL
   * - LOW
   *
   * Timeout:
   * Automatically terminates timed-out workers.
   *
   * Example:
   *
   * ```ts
   * await workerService.run(
   *   'ImageService',
   *   'generateThumbnail',
   *   [1920, 1080],
   *   {
   *     priority: 'HIGH',
   *     timeout: 3000,
   *   },
   * );
   * ```
   */
  run<T = unknown>(
    serviceName: string,
    methodName: string,
    args: unknown[] = [],
    overrides: { priority?: TaskPriority; timeout?: number } = {},
  ): Promise<T> {
    const key = `${serviceName}.${methodName}`;

    const defaults =
      this.taskOptions.get(key) ??
      {priority: 'NORMAL' as TaskPriority};

    return this.pool!.execute<T>({
      serviceName,
      methodName,
      args,
      priority: overrides.priority ?? defaults.priority,
      timeout: overrides.timeout ?? defaults.timeout,
    });
  }

  /**
   * Gracefully shuts down worker pool.
   *
   * Called automatically by NestJS
   * during application shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool?.destroy();
  }
}
