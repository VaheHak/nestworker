import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WorkerPool } from './worker.pool';
import { WorkerDiscoveryService } from '../discovery/discovery.service';
import { serializeForWorker } from '../di/di-serializer';
import type {
  TaskPriority,
  WorkerModuleOptions,
  ProxyServiceDescriptor,
  DeadLetterEvent,
  PoolStats,
  SerializedError,
  WorkerJob,
} from './worker.interfaces';

export type { DeadLetterEvent, PoolStats };

export interface RunOptions {
  priority?: TaskPriority;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  signal?: AbortSignal;
}

// Monotonic ID generator — far cheaper than crypto.randomUUID() and unique
// per-process which is all we need (jobs never leave this process). Numbers
// also clone ~3× faster than strings across the worker boundary and are
// cheaper Map keys than strings in V8.
let __jobIdCounter = 0;
const nextId = (): number => ++__jobIdCounter;

// Hot-path shared frozen sentinels — let v8 elide allocations on the common
// "no proxies / no ALS context" path.
const EMPTY_PROXIES: ProxyServiceDescriptor[] = Object.freeze(
  [],
) as unknown as ProxyServiceDescriptor[];
const DEFAULT_TASK = Object.freeze({ priority: 'NORMAL' as TaskPriority }) as {
  priority: TaskPriority;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
};

@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private pool: WorkerPool | null = null;

  private readonly taskDefaults = new Map<
    string,
    {
      priority: TaskPriority;
      timeout?: number;
      retry?: number;
      retryDelay?: number;
    }
  >();
  private readonly taskProxies = new Map<string, ProxyServiceDescriptor[]>();
  /** Cached array of ALS storages — avoids `?? []` + entries() per call. */
  private alsStorages: ReadonlyArray<{ getStore(): unknown }> = [];

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

    this.alsStorages = (this.options.asyncLocalStorages ??
      []) as ReadonlyArray<{
      getStore(): unknown;
    }>;

    const tasks = this.discovery.scan();

    const proxyMap = new Map<
      string,
      {
        methodNames: string[];
        instance: Record<string, (...args: unknown[]) => unknown>;
      }
    >();

    for (const task of tasks) {
      const key = `${task.serviceName}.${task.methodName}`;
      this.taskDefaults.set(key, {
        priority: task.priority,
        timeout: task.timeout,
        retry: task.retry,
        retryDelay: task.retryDelay,
      });

      const descriptors: ProxyServiceDescriptor[] = task.proxyInstances.map(
        (p) => {
          if (!proxyMap.has(p.propertyKey)) {
            proxyMap.set(p.propertyKey, {
              methodNames: p.methodNames,
              instance: p.instance,
            });
          }
          return { propertyKey: p.propertyKey, methodNames: p.methodNames };
        },
      );
      this.taskProxies.set(key, descriptors);
    }

    const serialized = serializeForWorker(tasks);
    const proxyInstances = Array.from(proxyMap.entries()).map(
      ([propertyKey, { methodNames, instance }]) => ({
        propertyKey,
        methodNames,
        instance,
      }),
    );

    this.pool = new WorkerPool(
      serialized,
      proxyInstances,
      this.options.poolSize,
      this.options.shutdownTimeout,
      this.options.concurrency,
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
    const defaults = this.taskDefaults.get(key) ?? DEFAULT_TASK;
    const proxyServices = this.taskProxies.get(key) ?? EMPTY_PROXIES;

    // Capture ALS context only if any storages are registered. Empty objects
    // still cost allocation + a structuredClone hop across the worker boundary.
    let alsContext: Record<string, unknown> | undefined;
    const storages = this.alsStorages;
    for (let i = 0, len = storages.length; i < len; i++) {
      const store = storages[i].getStore();
      if (store !== undefined) {
        (alsContext ??= {})[i < 10 ? String.fromCharCode(48 + i) : String(i)] =
          store;
      }
    }

    // Capture OTEL trace context if available (lazy, cached lookup).
    const traceContext = captureTraceContext();

    // Generate a unique signal ID if an AbortSignal was provided
    const abortSignalId = options.signal ? nextId() : undefined;

    // Build a *minimal* job object — every property we add gets walked by
    // structuredClone on every postMessage. Omitting empty/default fields
    // shrinks the wire payload and keeps the V8 object shape stable for
    // the common "no proxies / no ALS / no abort" hot path. Main-thread-only
    // metadata (priority/timeout/retry) is passed alongside, not on the wire.
    const job: WorkerJob = {
      jobId: nextId(),
      serviceName,
      methodName,
      args,
    };
    if (proxyServices !== EMPTY_PROXIES && proxyServices.length > 0) {
      job.proxyServices = proxyServices;
    }
    if (alsContext) job.alsContext = alsContext;
    if (traceContext !== EMPTY_TRACE) job.traceContext = traceContext;
    if (abortSignalId !== undefined) job.abortSignalId = abortSignalId;

    return this.pool!.execute<T>(
      job,
      {
        priority: options.priority ?? defaults.priority,
        timeout: options.timeout ?? defaults.timeout,
        retry: options.retry ?? defaults.retry,
        retryDelay: options.retryDelay ?? defaults.retryDelay,
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

  onTaskError(
    listener: (job: WorkerJob, error: SerializedError) => void,
  ): this {
    this.pool?.on('taskError', listener);
    return this;
  }

  /** Current pool stats — use for health checks and metrics */
  stats(): PoolStats {
    return (
      this.pool?.stats() ?? {
        poolSize: this.options.poolSize ?? 0,
        idle: 0,
        busy: 0,
        queued: 0,
        warmingUp: 0,
      }
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.destroy();
  }
}

/**
 * Capture the active OpenTelemetry trace context if @opentelemetry/api is
 * available. Returns an empty object otherwise — no hard dependency.
 *
 * The require() lookup is performed at most once and cached, since it shows
 * up on the hot path of every `run()` call.
 */
const EMPTY_TRACE: Record<string, string> = Object.freeze({}) as Record<
  string,
  string
>;
let __otelApi:
  | {
      propagation: {
        inject(ctx: unknown, carrier: Record<string, string>): void;
      };
      context: { active(): unknown };
    }
  | null
  | undefined;

function captureTraceContext(): Record<string, string> {
  if (__otelApi === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      __otelApi = require('@opentelemetry/api');
    } catch {
      __otelApi = null;
    }
  }
  if (!__otelApi) return EMPTY_TRACE;
  const carrier: Record<string, string> = {};
  __otelApi.propagation.inject(__otelApi.context.active(), carrier);
  // Return the shared empty object when nothing was injected to avoid
  // a per-call structuredClone of an empty object across the worker boundary.
  // Cheaper than Object.keys(carrier).length > 0 — no array allocation.
  for (const k in carrier) {
    if (Object.prototype.hasOwnProperty.call(carrier, k)) return carrier;
  }
  return EMPTY_TRACE;
}
