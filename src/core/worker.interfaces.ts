import type { AsyncLocalStorage } from 'node:async_hooks';

export type TaskPriority = 'HIGH' | 'NORMAL' | 'LOW';

// ── Job (main → worker) ───────────────────────────────────────────────────
//
// IMPORTANT: only fields the worker actually reads belong here. Everything
// else (priority, timeout, retry, retryDelay, attempt) lives on PendingTask
// in worker.pool.ts and never crosses the postMessage boundary — that keeps
// the structuredClone payload as small as possible on the hot path.

export interface WorkerJob {
  jobId: number;
  serviceName: string;
  methodName: string;
  args: unknown[];
  proxyServices?: ProxyServiceDescriptor[];
  /** ALS context snapshot — restored in worker before task runs */
  alsContext?: Record<string, unknown>;
  /** OTEL trace context — W3C traceparent/tracestate headers */
  traceContext?: Record<string, string>;
  /** AbortSignal is non-transferable; we send the signal ID instead */
  abortSignalId?: number;
}

// ── Job result (worker → main) ────────────────────────────────────────────

export interface WorkerResult<T = unknown> {
  type: 'result';
  /** ID of the job this result is for (required when concurrency > 1) */
  jobId?: number;
  ok: boolean;
  data?: T;
  error?: SerializedError;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  /** Any extra own enumerable properties on the original error */
  extra?: Record<string, unknown>;
}

// ── Abort (main → worker) ─────────────────────────────────────────────────

export interface WorkerAbortMessage {
  type: 'abort';
  abortSignalId: number;
}

// ── Proxy service descriptor ──────────────────────────────────────────────

export interface ProxyServiceDescriptor {
  propertyKey: string;
  methodNames: string[];
}

// ── IPC round-trip messages ───────────────────────────────────────────────

export interface IpcInvokeRequest {
  type: 'ipc:invoke';
  callId: number;
  propertyKey: string;
  methodName: string;
  args: unknown[];
}

export interface IpcInvokeResponse {
  type: 'ipc:result';
  callId: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── Worker lifecycle ──────────────────────────────────────────────────────

export interface WorkerReadySignal {
  type: 'worker:ready';
}

// ── Batched job/result envelopes ──────────────────────────────────────────
//
// To break the per-message structuredClone overhead ceiling we coalesce
// multiple jobs/results into a single postMessage. Batching is automatic:
// the pool packs everything it dispatches in a single schedule pass into
// one envelope per worker, and the worker flushes accumulated results once
// per microtask tick.

export interface WorkerJobBatch {
  type: 'batch';
  jobs: WorkerJob[];
}

export interface WorkerResultBatch {
  type: 'results';
  results: WorkerResult[];
}

// ── Discriminated union message types ─────────────────────────────────────

export type WorkerInboundMessage =
  | WorkerJob
  | WorkerJobBatch
  | IpcInvokeResponse
  | WorkerAbortMessage;

export type WorkerOutboundMessage =
  | WorkerResult
  | WorkerResultBatch
  | IpcInvokeRequest
  | WorkerReadySignal;

// ── Dead letter event ─────────────────────────────────────────────────────

export interface DeadLetterEvent {
  jobId: number;
  serviceName: string;
  methodName: string;
  args: unknown[];
  attempts: number;
  error: SerializedError;
  failedAt: Date;
}

// ── Internal discovery types ──────────────────────────────────────────────

export interface DiscoveredTask {
  serviceName: string;
  methodName: string;
  priority: TaskPriority;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  fn: (...args: unknown[]) => unknown;
  metatype: new (...args: unknown[]) => unknown;
  instance: unknown;
  deps: unknown[];
  proxyInstances: ProxyInstance[];
}

export interface ProxyInstance {
  propertyKey: string;
  methodNames: string[];
  instance: Record<string, (...args: unknown[]) => unknown>;
}

// ── Module options ────────────────────────────────────────────────────────

export interface WorkerModuleOptions {
  /** Number of worker threads. Defaults to os.cpus().length */
  poolSize?: number;
  /**
   * Maximum number of in-flight jobs per worker. Defaults to 1.
   *
   * Set > 1 to pipeline jobs into each worker: the main thread will keep
   * dispatching to a worker as long as its in-flight count is below this
   * limit, so the worker never sits idle between jobs while the main thread
   * is processing a result. Significant throughput win for short tasks and
   * for tasks that await I/O (proxy IPC, fetch, fs, ...).
   *
   * Safe to keep at 1 for purely CPU-bound, blocking tasks.
   */
  concurrency?: number;
  /**
   * How long (ms) to wait for in-flight jobs to finish before force-killing
   * workers on application shutdown. Defaults to 30_000.
   */
  shutdownTimeout?: number;
  /**
   * AsyncLocalStorage instances whose current store should be propagated
   * into worker tasks. Pass the same ALS instances you use in your app.
   */
  asyncLocalStorages?: AsyncLocalStorage<unknown>[];
}

export interface WorkerModuleAsyncOptions {
  inject?: unknown[];
  useFactory: (
    ...args: unknown[]
  ) => WorkerModuleOptions | Promise<WorkerModuleOptions>;
}

// ── Pool stats (for health + metrics) ─────────────────────────────────────

export interface PoolStats {
  poolSize: number;
  idle: number;
  busy: number;
  queued: number;
  warmingUp: number;
}
