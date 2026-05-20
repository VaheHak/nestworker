import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import type {
  WorkerJob,
  WorkerResult,
  WorkerOutboundMessage,
  TaskPriority,
  ProxyInstance,
  IpcInvokeRequest,
  IpcInvokeResponse,
  DeadLetterEvent,
  SerializedError,
  PoolStats,
} from './worker.interfaces';

import type { SerializedService } from '../di/worker-container';

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
};

type PendingTask = {
  job: WorkerJob;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  /** Attempts already made (0 = never tried) */
  attempts: number;
  /** AbortSignal supplied by the caller */
  signal?: AbortSignal;
};

export declare interface WorkerPool {
  on(event: 'dead', listener: (event: DeadLetterEvent) => void): this;
  on(event: 'error', listener: (err: Error, job: WorkerJob) => void): this;
  on(event: 'taskStart', listener: (job: WorkerJob) => void): this;
  on(event: 'taskEnd', listener: (job: WorkerJob, durationMs: number) => void): this;
  on(event: 'taskError', listener: (job: WorkerJob, error: SerializedError) => void): this;
  emit(event: 'dead', payload: DeadLetterEvent): boolean;
  emit(event: 'error', err: Error, job: WorkerJob): boolean;
  emit(event: 'taskStart', job: WorkerJob): boolean;
  emit(event: 'taskEnd', job: WorkerJob, durationMs: number): boolean;
  emit(event: 'taskError', job: WorkerJob, error: SerializedError): boolean;
}

export class WorkerPool extends EventEmitter {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly warmingUp = new Set<Worker>();
  private readonly queue: PendingTask[] = [];
  private destroyed = false;
  private readonly active = new Map<Worker, { task: PendingTask; priority: TaskPriority; startedAt: number }>();

  /** Maps abortSignalId → worker currently running that job */
  private readonly signalWorkerMap = new Map<string, Worker>();

  private readonly proxyMap = new Map<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >();

  constructor(
    private readonly services: SerializedService[],
    proxyInstances: ProxyInstance[],
    private readonly size = os.cpus().length,
    private readonly shutdownTimeout = 30_000,
  ) {
    super();
    for (const { propertyKey, instance } of proxyInstances) {
      this.proxyMap.set(propertyKey, instance);
    }
    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  execute<T = unknown>(job: WorkerJob, signal?: AbortSignal): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('WorkerPool destroyed'));

    return new Promise<T>((resolve, reject) => {
      // Reject immediately if already aborted
      if (signal?.aborted) {
        reject(new DOMException('Task aborted before enqueue', 'AbortError'));
        return;
      }

      const task: PendingTask = {
        job,
        resolve: resolve as (v: unknown) => void,
        reject,
        attempts: 0,
        signal,
      };

      if (signal) {
        signal.addEventListener('abort', () => {
          // Remove from queue if not yet dispatched
          const idx = this.queue.indexOf(task);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new DOMException('Task aborted', 'AbortError'));
            return;
          }
          // Already running — send abort signal to worker
          if (job.abortSignalId) {
            const worker = this.signalWorkerMap.get(job.abortSignalId);
            if (worker) {
              try { worker.postMessage({ type: 'abort', abortSignalId: job.abortSignalId }); }
              catch { /* worker gone */ }
            }
          }
        }, { once: true });
      }

      this.enqueue(task);
      this.schedule();
    });
  }

  stats(): PoolStats {
    return {
      poolSize: this.size,
      idle: this.idle.length,
      busy: this.active.size,
      queued: this.queue.length,
      warmingUp: this.warmingUp.size,
    };
  }

  private spawnWorker(): Worker {
    const worker = new Worker(
      path.resolve(__dirname, '../worker/worker-runtime.js'),
      { workerData: { services: this.services } },
    );
    this.workers.push(worker);
    this.warmingUp.add(worker);

    const onReady = (msg: unknown) => {
      const message = msg as { type?: string };
      if (message?.type !== 'worker:ready') return;
      worker.removeListener('message', onReady);
      this.warmingUp.delete(worker);
      if (!this.destroyed) {
        this.idle.push(worker);
        this.schedule();
      }
    };

    worker.on('message', onReady);
    worker.once('error', (err) => this.handleWorkerError(worker, err));
    worker.once('exit', (code) => this.handleWorkerExit(worker, code));
    return worker;
  }

  private enqueue(task: PendingTask): void {
    const weight = PRIORITY_WEIGHT[task.job.priority];
    let lo = 0, hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (PRIORITY_WEIGHT[this.queue[mid].job.priority] < weight) hi = mid;
      else lo = mid + 1;
    }
    this.queue.splice(lo, 0, task);
  }

  private schedule(): void {
    if (this.destroyed) return;
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.dispatch(worker, task);
    }
  }

  private dispatch(worker: Worker, task: PendingTask): void {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const startedAt = Date.now();

    task.attempts++;
    task.job.attempt = task.attempts - 1;

    this.active.set(worker, { task, priority: task.job.priority, startedAt });

    if (task.job.abortSignalId) {
      this.signalWorkerMap.set(task.job.abortSignalId, worker);
    }

    this.emit('taskStart', task.job);

    const cleanup = () => {
      worker.removeListener('message', onMessage);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (task.job.abortSignalId) {
        this.signalWorkerMap.delete(task.job.abortSignalId);
      }
    };

    const recycle = () => {
      cleanup();
      this.active.delete(worker);
      if (!this.destroyed) {
        this.idle.push(worker);
        this.schedule();
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      recycle();
    };

    const handleFailure = (serializedError: SerializedError) => {
      const { retry = 0, retryDelay = 0 } = task.job;
      this.emit('taskError', task.job, serializedError);

      if (task.attempts < retry + 1) {
        // Re-enqueue with delay
        const delay = typeof retryDelay === 'number' ? retryDelay : 0;
        const scheduleRetry = () => {
          this.enqueue(task);
          this.schedule();
        };
        if (delay > 0) setTimeout(scheduleRetry, delay);
        else scheduleRetry();
        return;
      }

      // All attempts exhausted → dead letter
      const dlEvent: DeadLetterEvent = {
        jobId: task.job.jobId,
        serviceName: task.job.serviceName,
        methodName: task.job.methodName,
        args: task.job.args,
        attempts: task.attempts,
        error: serializedError,
        failedAt: new Date(),
      };
      this.emit('dead', dlEvent);
      task.reject(deserializeError(serializedError));
    };

    const onMessage = async (msg: unknown) => {
      const message = msg as WorkerOutboundMessage;

      // ── IPC invoke from worker ────────────────────────────────────────
      if (message.type === 'ipc:invoke') {
        const req = message as IpcInvokeRequest;
        const svcInstance = this.proxyMap.get(req.propertyKey);

        const reply = (res: IpcInvokeResponse) => {
          try { worker.postMessage(res); }
          catch {
            try {
              worker.postMessage({
                type: 'ipc:result', callId: res.callId, ok: false,
                error: `IPC result for "${req.propertyKey}.${req.methodName}" ` +
                  `is not structuredClone-compatible.`,
              } satisfies IpcInvokeResponse);
            } catch { /* worker gone */ }
          }
        };

        if (!svcInstance) {
          reply({ type: 'ipc:result', callId: req.callId, ok: false,
            error: `No proxy registered for "${req.propertyKey}"` });
          return;
        }
        const method = svcInstance[req.methodName];
        if (typeof method !== 'function') {
          reply({ type: 'ipc:result', callId: req.callId, ok: false,
            error: `Method "${req.methodName}" not found on "${req.propertyKey}"` });
          return;
        }
        try {
          // Call via svcInstance[method]() to preserve `this` binding.
          // Detached call (const fn = svcInstance[m]; fn()) loses `this`
          // in strict mode, breaking any method that reads instance properties.
          const data = await svcInstance[req.methodName](...(req.args as unknown[]));
          reply({ type: 'ipc:result', callId: req.callId, ok: true, data });
        } catch (err: unknown) {
          reply({ type: 'ipc:result', callId: req.callId, ok: false,
            error: (err as Error).message ?? String(err) });
        }
        return;
      }

      if (message.type === 'worker:ready') return;

      // ── Job result ────────────────────────────────────────────────────
      const result = message as WorkerResult;
      const durationMs = Date.now() - startedAt;

      settle(() => {
        if (result.ok) {
          this.emit('taskEnd', task.job, durationMs);
          task.resolve(result.data);
        } else {
          handleFailure(result.error ?? {
            name: 'Error',
            message: 'Unknown worker error',
          });
        }
      });
    };

    worker.on('message', onMessage);

    if (task.job.timeout && task.job.timeout > 0) {
      timeoutHandle = setTimeout(async () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.active.delete(worker);

        const serializedError: SerializedError = {
          name: 'TimeoutError',
          message: `Task "${task.job.serviceName}.${task.job.methodName}" ` +
            `timed out after ${task.job.timeout}ms`,
        };
        handleFailure(serializedError);

        try { await worker.terminate(); } catch {}
        this.replaceWorker(worker);
        this.schedule();
      }, task.job.timeout);
    }

    worker.postMessage(task.job);
  }

  private handleWorkerError(worker: Worker, err: Error): void {
    const running = this.active.get(worker);
    if (running) {
      const { serviceName, methodName } = running.task.job;
      const wrapped = new Error(`Worker crashed in "${serviceName}.${methodName}": ${err.message}`);
      wrapped.stack = err.stack;
      this.emit('error', wrapped, running.task.job);
      running.task.reject(wrapped);
      this.active.delete(worker);
    }
    this.replaceWorker(worker);
  }

  private handleWorkerExit(worker: Worker, code: number): void {
    if (this.destroyed) return;
    const running = this.active.get(worker);
    if (running) {
      running.task.reject(new Error(
        `Worker exited with code ${code} while running ` +
        `"${running.task.job.serviceName}.${running.task.job.methodName}"`
      ));
      this.active.delete(worker);
    }
    this.replaceWorker(worker);
  }

  private replaceWorker(oldWorker: Worker): void {
    const remove = (arr: Worker[]) => {
      const i = arr.indexOf(oldWorker);
      if (i >= 0) arr.splice(i, 1);
    };
    remove(this.workers);
    remove(this.idle);
    this.warmingUp.delete(oldWorker);
    if (!this.destroyed) {
      this.spawnWorker();
      this.schedule();
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;

    // Drain: wait for all active jobs to finish, up to shutdownTimeout
    if (this.active.size > 0) {
      await Promise.race([
        // Wait for all active jobs to settle
        Promise.allSettled(
          Array.from(this.active.values()).map(
            ({ task }) => new Promise<void>((res) => {
              const orig = task.resolve;
              const origRej = task.reject;
              task.resolve = (v) => { orig(v); res(); };
              task.reject = (e) => { origRej(e); res(); };
            })
          )
        ),
        // Force after timeout
        new Promise<void>((res) => setTimeout(res, this.shutdownTimeout)),
      ]);
    }

    // Reject anything still queued
    for (const queued of this.queue) {
      queued.reject(new Error('WorkerPool destroyed'));
    }
    this.queue.length = 0;

    await Promise.allSettled(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

function deserializeError(serialized: SerializedError): Error {
  const err = new Error(serialized.message);
  err.name = serialized.name;
  if (serialized.stack) err.stack = serialized.stack;
  if (serialized.extra) Object.assign(err, serialized.extra);
  return err;
}
