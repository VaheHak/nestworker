import {
  Inject, Injectable, Logger,
  OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import crypto from 'node:crypto';
import { WorkerPool } from './worker.pool';
import { WorkerDiscoveryService } from '../discovery/discovery.service';
import { serializeForWorker } from '../di/di-serializer';
import type {
  TaskPriority,
  WorkerModuleOptions,
  ProxyServiceDescriptor,
  DeadLetterEvent,
  PoolStats,
  SerializedError, WorkerJob,
} from './worker.interfaces';

export type { DeadLetterEvent, PoolStats };

export interface RunOptions {
  priority?: TaskPriority;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  signal?: AbortSignal;
}

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private pool: WorkerPool | null = null;

  private readonly taskDefaults = new Map<
    string,
    { priority: TaskPriority; timeout?: number; retry?: number; retryDelay?: number }
  >();
  private readonly taskProxies = new Map<string, ProxyServiceDescriptor[]>();

  constructor(
    private readonly discovery: WorkerDiscoveryService,
    @Inject('WORKER_OPTIONS')
    private readonly options: WorkerModuleOptions,
  ) {}

  onModuleInit(): void {
    this.initPool();
  }

  private initPool(): void {
    if (this.pool) return;

    const tasks = this.discovery.scan();

    const proxyMap = new Map<
      string,
      { methodNames: string[]; instance: Record<string, (...args: unknown[]) => unknown> }
    >();

    for (const task of tasks) {
      const key = `${task.serviceName}.${task.methodName}`;
      this.taskDefaults.set(key, {
        priority: task.priority,
        timeout: task.timeout,
        retry: task.retry,
        retryDelay: task.retryDelay,
      });

      const descriptors: ProxyServiceDescriptor[] = task.proxyInstances.map((p) => {
        if (!proxyMap.has(p.propertyKey)) {
          proxyMap.set(p.propertyKey, { methodNames: p.methodNames, instance: p.instance });
        }
        return { propertyKey: p.propertyKey, methodNames: p.methodNames };
      });
      this.taskProxies.set(key, descriptors);
    }

    const serialized = serializeForWorker(tasks);
    const proxyInstances = Array.from(proxyMap.entries()).map(
      ([propertyKey, { methodNames, instance }]) => ({ propertyKey, methodNames, instance })
    );

    this.pool = new WorkerPool(
      serialized,
      proxyInstances,
      this.options.poolSize,
      this.options.shutdownTimeout,
    );

    // Forward pool events to logger and expose via EventEmitter
    this.pool.on('dead', (event: DeadLetterEvent) => {
      this.logger.error(
        `Dead letter: ${event.serviceName}.${event.methodName} ` +
        `failed after ${event.attempts} attempt(s) — ${event.error.message}`,
      );
    });
    this.pool.on('error', (err: Error) => {
      this.logger.error(`Worker pool error: ${err.message}`, err.stack);
    });
  }

  /**
   * Run a @WorkerTask method in a worker thread.
   *
   * @param serviceName  Class name of the @WorkerClass provider
   * @param methodName   Method decorated with @WorkerTask
   * @param args         structuredClone-compatible arguments
   * @param options      Optional priority / timeout / retry / AbortSignal overrides
   */
  run<T = unknown>(
    serviceName: string,
    methodName: string,
    args: unknown[] = [],
    options: RunOptions = {},
  ): Promise<T> {
    const key = `${serviceName}.${methodName}`;
    const defaults = this.taskDefaults.get(key) ?? { priority: 'NORMAL' as TaskPriority };
    const proxyServices = this.taskProxies.get(key) ?? [];

    // Capture ALS context from all registered storages
    const alsContext: Record<string, unknown> = {};
    for (const [i, als] of (this.options.asyncLocalStorages ?? []).entries()) {
      const store = als.getStore();
      if (store !== undefined) alsContext[String(i)] = store;
    }

    // Capture OTEL trace context if available
    const traceContext = captureTraceContext();

    // Generate a unique signal ID if an AbortSignal was provided
    const abortSignalId = options.signal ? crypto.randomUUID() : undefined;

    return this.pool!.execute<T>(
      {
        jobId: crypto.randomUUID(),
        serviceName,
        methodName,
        args,
        priority: options.priority ?? defaults.priority,
        timeout: options.timeout ?? defaults.timeout,
        retry: options.retry ?? defaults.retry ?? 0,
        retryDelay: options.retryDelay ?? defaults.retryDelay ?? 0,
        proxyServices,
        alsContext,
        traceContext,
        abortSignalId,
      },
      options.signal,
    );
  }

  /** Listen for dead-letter events (jobs that exhausted all retry attempts) */
  onDead(listener: (event: DeadLetterEvent) => void): this {
    this.pool?.on('dead', listener);
    return this;
  }

  /** Listen for task lifecycle events */
  onTaskEnd(listener: (job: WorkerJob, durationMs: number) => void): this {
    this.pool?.on('taskEnd', listener);
    return this;
  }

  onTaskStart(listener: (job: WorkerJob) => void): this {
    this.pool?.on('taskStart', listener);
    return this;
  }

  onTaskError(listener: (job: WorkerJob, error: SerializedError) => void): this {
    this.pool?.on('taskError', listener);
    return this;
  }

  /** Current pool stats — use for health checks and metrics */
  stats(): PoolStats {
    return this.pool?.stats() ?? {
      poolSize: this.options.poolSize ?? 0,
      idle: 0, busy: 0, queued: 0, warmingUp: 0,
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.destroy();
  }
}

/**
 * Capture the active OpenTelemetry trace context if @opentelemetry/api is
 * available. Returns an empty object otherwise — no hard dependency.
 */
function captureTraceContext(): Record<string, string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('@opentelemetry/api') as {
      propagation: { inject(ctx: unknown, carrier: Record<string, string>): void };
      context: { active(): unknown };
    };
    const carrier: Record<string, string> = {};
    api.propagation.inject(api.context.active(), carrier);
    return carrier;
  } catch {
    return {};
  }
}
