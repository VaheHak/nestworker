import type { AsyncLocalStorage } from 'node:async_hooks';

export type TaskPriority = 'HIGH' | 'NORMAL' | 'LOW';

// ── Job (main → worker) ───────────────────────────────────────────────────

export interface WorkerJob {
  jobId: string;
  serviceName: string;
  methodName: string;
  args: unknown[];
  priority: TaskPriority;
  timeout?: number;
  /** Retry policy — sourced from @WorkerTask or overridden per call */
  retry?: number;
  retryDelay?: number;
  /** Current attempt index (0 = first attempt) */
  attempt?: number;
  proxyServices?: ProxyServiceDescriptor[];
  /** ALS context snapshot — restored in worker before task runs */
  alsContext?: Record<string, unknown>;
  /** OTEL trace context — W3C traceparent/tracestate headers */
  traceContext?: Record<string, string>;
  /** AbortSignal is non-transferable; we send the signal ID instead */
  abortSignalId?: string;
}

// ── Job result (worker → main) ────────────────────────────────────────────

export interface WorkerResult<T = unknown> {
  type: 'result';
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
  abortSignalId: string;
}

// ── Proxy service descriptor ──────────────────────────────────────────────

export interface ProxyServiceDescriptor {
  propertyKey: string;
  methodNames: string[];
}

// ── IPC round-trip messages ───────────────────────────────────────────────

export interface IpcInvokeRequest {
  type: 'ipc:invoke';
  callId: string;
  propertyKey: string;
  methodName: string;
  args: unknown[];
}

export interface IpcInvokeResponse {
  type: 'ipc:result';
  callId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── Worker lifecycle ──────────────────────────────────────────────────────

export interface WorkerReadySignal {
  type: 'worker:ready';
}

// ── Discriminated union message types ─────────────────────────────────────

export type WorkerInboundMessage =
  | WorkerJob
  | IpcInvokeResponse
  | WorkerAbortMessage;

export type WorkerOutboundMessage =
  | WorkerResult
  | IpcInvokeRequest
  | WorkerReadySignal;

// ── Dead letter event ─────────────────────────────────────────────────────

export interface DeadLetterEvent {
  jobId: string;
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
  useFactory: (...args: unknown[]) => WorkerModuleOptions | Promise<WorkerModuleOptions>;
}

// ── Pool stats (for health + metrics) ─────────────────────────────────────

export interface PoolStats {
  poolSize: number;
  idle: number;
  busy: number;
  queued: number;
  warmingUp: number;
}
