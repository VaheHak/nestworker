import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
  WorkerLogger,
} from './worker.interfaces';

export type { DeadLetterEvent, PoolStats, WorkerLogger };
export { QueueFullError } from './worker.pool';

export interface RunOptions {
  priority?: TaskPriority;
  timeout?: number;
  retry?: number;
  /** Numeric delay or a function `(attempt) => ms` (evaluated main-side). */
  retryDelay?: number | ((attempt: number) => number);
  signal?: AbortSignal;
}

/**
 * Method-typed handle returned by `WorkerService.invoke(Class)`. Calling any
 * method on it delegates to `run(Class.name, methodName, args)` so consumers
 * get compile-time safety on both the method name and its argument shape.
 *
 * Note: the runtime task still executes in a worker, so the return type is
 * always wrapped in a Promise.
 */
export type WorkerInvocation<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (
    ...args: infer A
  ) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

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
  private readonly logger: WorkerLogger;
  private pool: WorkerPool | null = null;

  private readonly taskDefaults = new Map<
    string,
    {
      priority: TaskPriority;
      timeout?: number;
      retry?: number;
      retryDelay?: number | ((attempt: number) => number);
    }
  >();
  private readonly taskProxies = new Map<string, ProxyServiceDescriptor[]>();
  /** Cached array of ALS storages — avoids `?? []` + entries() per call. */
  private alsStorages: ReadonlyArray<{ getStore(): unknown }> = [];

  /**
   * Listener subscriptions registered before `onModuleInit` ran. Once the
   * pool is created, we replay them onto it. Without this, calling
   * `workerService.onDead(...)` from another `onModuleInit` (race depending
   * on Nest provider init order) would silently no-op.
   */
  private readonly pendingListeners: Array<
    [event: string, listener: (...args: unknown[]) => void]
  > = [];

  constructor(
    private readonly discovery: WorkerDiscoveryService,
    @Inject('WORKER_OPTIONS')
    private readonly options: WorkerModuleOptions,
  ) {
    // Default to Nest's Logger; users can plug in pino/winston/etc.
    this.logger = (options.logger as WorkerLogger | undefined) ?? new Logger(WorkerService.name);
  }

  onModuleInit(): void {
    this.initPool();
  }

  private initPool(): void {
    if (this.pool) return;

    this.alsStorages = (this.options.asyncLocalStorages ?? []) as ReadonlyArray<{
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

      const descriptors: ProxyServiceDescriptor[] = task.proxyInstances.map((p) => {
        if (!proxyMap.has(p.propertyKey)) {
          proxyMap.set(p.propertyKey, {
            methodNames: p.methodNames,
            instance: p.instance,
          });
        }
        return { propertyKey: p.propertyKey, methodNames: p.methodNames };
      });
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
      this.options.maxQueueDepth,
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

    // Replay any subscriptions registered before init.
    for (const [event, listener] of this.pendingListeners) {
      (this.pool as unknown as { on(e: string, l: typeof listener): void }).on(event, listener);
    }
    this.pendingListeners.length = 0;
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

    // Capture ALS context only if any storages are registered. Empty arrays
    // still cost allocation + a structuredClone hop across the worker boundary.
    // We encode as a positional array (vs the previous object with single-char
    // keys) — smaller payload, faster clone, supports >10 storages, and the
    // worker can index directly without parsing string keys.
    let alsContext: unknown[] | undefined;
    const storages = this.alsStorages;
    for (let i = 0, len = storages.length; i < len; i++) {
      const store = storages[i].getStore();
      if (store !== undefined) {
        if (!alsContext) alsContext = new Array(len);
        alsContext[i] = store;
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
    this.subscribe('dead', listener as (...a: unknown[]) => void);
    return this;
  }

  /** Listen for task lifecycle events */
  onTaskEnd(listener: (job: WorkerJob, durationMs: number) => void): this {
    this.subscribe('taskEnd', listener as (...a: unknown[]) => void);
    return this;
  }

  onTaskStart(listener: (job: WorkerJob) => void): this {
    this.subscribe('taskStart', listener as (...a: unknown[]) => void);
    return this;
  }

  onTaskError(listener: (job: WorkerJob, error: SerializedError) => void): this {
    this.subscribe('taskError', listener as (...a: unknown[]) => void);
    return this;
  }

  /** Internal: subscribe immediately if pool exists, otherwise buffer. */
  private subscribe(event: string, listener: (...args: unknown[]) => void): void {
    if (this.pool) {
      (this.pool as unknown as { on(e: string, l: typeof listener): void }).on(event, listener);
    } else {
      this.pendingListeners.push([event, listener]);
    }
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
        saturation: 0,
        maxQueueDepth: this.options.maxQueueDepth ?? Number.POSITIVE_INFINITY,
      }
    );
  }

  /**
   * Typed invocation helper. Returns a Proxy whose methods mirror the worker
   * class shape — calling `ws.invoke(ImageService).resize(buf)` is equivalent
   * to `ws.run('ImageService', 'resize', [buf])` but checked at compile time.
   *
   * Pass `options` to override priority/timeout/retry/signal for the chained
   * call (mirrors `RunOptions` on `run()`).
   *
   *   ws.invoke(ImageService).resize(buf)
   *   ws.invoke(ImageService, { timeout: 5_000 }).resize(buf)
   */
  invoke<T extends object>(
    target: new (...args: never[]) => T,
    options: RunOptions = {},
  ): WorkerInvocation<T> {
    const serviceName = target.name;
    // Cache the per-method bound run-fn so repeated calls don't reallocate.
    // The Proxy itself is recreated per invoke() call to honour fresh options.
    const handler: ProxyHandler<Record<string, never>> = {
      get: (_t, prop: string | symbol) => {
        if (typeof prop !== 'string') return undefined;
        return (...args: unknown[]) => this.run(serviceName, prop, args, options);
      },
    };
    return new Proxy({} as Record<string, never>, handler) as unknown as WorkerInvocation<T>;
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
const EMPTY_TRACE: Record<string, string> = Object.freeze({}) as Record<string, string>;
let __otelApi:
  | {
      propagation: {
        inject(ctx: unknown, carrier: Record<string, string>): void;
      };
      context: { active(): unknown };
      trace?: { getSpan(ctx: unknown): unknown };
    }
  | null
  | undefined;
let __otelEmptyContext: unknown;

function captureTraceContext(): Record<string, string> {
  if (__otelApi === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      __otelApi = require('@opentelemetry/api');
      __otelEmptyContext = __otelApi?.context.active();
    } catch {
      __otelApi = null;
    }
  }
  if (!__otelApi) return EMPTY_TRACE;
  const active = __otelApi.context.active();
  // Fast path: no active span on the active context → propagation.inject
  // would emit nothing, so skip the carrier allocation entirely.
  if (
    active === __otelEmptyContext ||
    (__otelApi.trace && __otelApi.trace.getSpan(active) === undefined)
  ) {
    return EMPTY_TRACE;
  }
  const carrier: Record<string, string> = {};
  __otelApi.propagation.inject(active, carrier);
  for (const k in carrier) {
    if (Object.prototype.hasOwnProperty.call(carrier, k)) return carrier;
  }
  return EMPTY_TRACE;
}
