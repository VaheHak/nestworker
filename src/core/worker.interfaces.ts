export type TaskPriority = 'HIGH' | 'NORMAL' | 'LOW';

export interface WorkerJob {
  serviceName: string;
  methodName: string;
  args: unknown[];
  /** Sourced from @WorkerTask({ priority }) — used by WorkerPool to sort the queue */
  priority: TaskPriority;
  /** Sourced from @WorkerTask({ timeout }) — rejects the job after this many ms */
  timeout?: number;
}

export interface WorkerResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { message: string; stack?: string };
}

export interface DiscoveredTask {
  serviceName: string;
  methodName: string;
  priority: TaskPriority;
  timeout?: number;
  /** Bound method on the live main-thread instance */
  fn: (...args: unknown[]) => unknown;
  /** Class constructor — used to locate the compiled file and read metadata */
  metatype: new (...args: unknown[]) => unknown;
  /** Live main-thread service instance — used to locate dep property keys */
  instance: unknown;
  /** Resolved dep instances from the NestJS container, in declaration order */
  deps: unknown[];
}

export interface WorkerModuleOptions {
  /** Number of worker threads. Defaults to os.cpus().length */
  poolSize?: number;
}
