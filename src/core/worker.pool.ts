import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import type {
  WorkerJob,
  WorkerJobBatch,
  WorkerResult,
  WorkerResultBatch,
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
  /** Priority is main-thread-only (queue ordering) — kept off the wire. */
  priority: TaskPriority;
  /** Timeout / retry policy is main-thread-only too. */
  timeout?: number;
  retry?: number;
  retryDelay?: number;
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

// Per-worker state attached via a symbol-keyed slot — avoids a Map lookup
// per message and per dispatch on the hot path.
const STATE = Symbol('nestworker:state');

type ActiveSlot = {
  task: PendingTask;
  startedAt: number;
  timeoutHandle?: NodeJS.Timeout;
  settled: boolean;
};

type WorkerState = {
  /** In-flight jobs keyed by jobId (size <= concurrency). */
  active: Map<number, ActiveSlot>;
};

function getState(worker: Worker): WorkerState {
  return (worker as unknown as { [STATE]: WorkerState })[STATE];
}

export class WorkerPool extends EventEmitter {
  private readonly workers: Worker[] = [];
  /**
   * Available "slots" — each worker is pushed `concurrency` times when it
   * becomes ready, then popped/pushed as jobs are dispatched/completed.
   * This naturally supports per-worker pipelining without any per-job
   * counter bookkeeping.
   */
  private readonly idle: Worker[] = [];
  private readonly warmingUp = new Set<Worker>();
  // Head-index FIFO: queue.shift() is O(n); a head pointer makes pop O(1)
  // and the array is compacted lazily when it grows wasteful.
  private readonly queue: PendingTask[] = [];
  private queueHead = 0;
  private destroyed = false;
  private activeCount = 0;
  /**
   * `schedule()` is invoked many times in a single synchronous burst (e.g.
   * `for (...) ws.run(...)` floods 20k enqueues). Running the dispatch loop
   * after every enqueue limits us to batches of size 1 per worker — the
   * whole point of batching is then defeated. Defer to the next microtask
   * so all synchronously-enqueued jobs land in one schedule pass and get
   * coalesced into a single postMessage per worker.
   */
  private scheduleQueued = false;

  /** Maps abortSignalId → worker currently running that job */
  private readonly signalWorkerMap = new Map<number, Worker>();

  private readonly concurrency: number;

  private readonly proxyMap = new Map<
    string,
    Record<string, (...args: unknown[]) => unknown>
  >();

  constructor(
    private readonly services: SerializedService[],
    proxyInstances: ProxyInstance[],
    private readonly size = os.cpus().length,
    private readonly shutdownTimeout = 30_000,
    concurrency = 1,
  ) {
    super();
    this.concurrency = concurrency > 0 ? concurrency : 1;
    for (const { propertyKey, instance } of proxyInstances) {
      this.proxyMap.set(propertyKey, instance);
    }
    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  execute<T = unknown>(
    job: WorkerJob,
    meta: { priority: TaskPriority; timeout?: number; retry?: number; retryDelay?: number },
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('WorkerPool destroyed'));

    return new Promise<T>((resolve, reject) => {
      // Reject immediately if already aborted
      if (signal?.aborted) {
        reject(new DOMException('Task aborted before enqueue', 'AbortError'));
        return;
      }

      const task: PendingTask = {
        job,
        priority: meta.priority,
        timeout: meta.timeout,
        retry: meta.retry,
        retryDelay: meta.retryDelay,
        resolve: resolve as (v: unknown) => void,
        reject,
        attempts: 0,
        signal,
      };

      if (signal) {
        signal.addEventListener('abort', () => {
          // Remove from queue if not yet dispatched. Use head-index aware
          // search and tombstone with `undefined` to avoid an O(n) splice.
          const q = this.queue;
          for (let i = this.queueHead; i < q.length; i++) {
            if (q[i] === task) {
              (q as unknown as (PendingTask | undefined)[])[i] = undefined as never;
              // If it's at the head, advance past it.
              while (this.queueHead < q.length && q[this.queueHead] === undefined) {
                this.queueHead++;
              }
              reject(new DOMException('Task aborted', 'AbortError'));
              return;
            }
          }
          // Already running — send abort signal to worker
          if (job.abortSignalId !== undefined) {
            const worker = this.signalWorkerMap.get(job.abortSignalId);
            if (worker) {
              try {
                worker.postMessage({ type: 'abort', abortSignalId: job.abortSignalId });
              } catch { /* worker gone */
              }
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
      busy: this.activeCount,
      queued: this.queue.length - this.queueHead,
      warmingUp: this.warmingUp.size,
    };
  }

  private spawnWorker(): Worker {
    const worker = new Worker(
      path.resolve(__dirname, '../worker/worker-runtime.js'),
      { workerData: { services: this.services } },
    );
    (worker as unknown as { [STATE]: WorkerState })[STATE] = { active: new Map() };
    this.workers.push(worker);
    this.warmingUp.add(worker);

    // ── Single persistent message listener ───────────────────────────────
    // We used to add/remove a listener per dispatch — that allocated several
    // closures and mutated the EventEmitter's listener array on every task.
    // Instead we install one listener whose behaviour switches based on
    // whether this worker is currently warming up or running a task.
    const onMessage = (msg: unknown) => {
      const message = msg as { type?: string };

      if (this.warmingUp.has(worker)) {
        if (message?.type !== 'worker:ready') return;
        this.warmingUp.delete(worker);
        if (!this.destroyed) {
          // Push the worker into the idle queue once per concurrency slot
          // so the scheduler will pipeline up to N jobs into it.
          for (let i = 0; i < this.concurrency; i++) this.idle.push(worker);
          this.schedule();
        }
        return;
      }

      // Spurious `worker:ready` after warmup → ignore.
      if (message?.type === 'worker:ready') return;

      // IPC invoke from worker is not job-scoped — handle inline.
      if (message?.type === 'ipc:invoke') {
        this.handleIpcInvoke(worker, message as unknown as IpcInvokeRequest);
        return;
      }

      // Batched job results — route each by jobId.
      if (message?.type === 'results') {
        const batch = message as unknown as WorkerResultBatch;
        const state = getState(worker);
        const results = batch.results;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const slot = r.jobId !== undefined ? state.active.get(r.jobId) : undefined;
          if (!slot) continue;
          state.active.delete(r.jobId!);
          this.completeJob(worker, slot, r);
        }
        if (!this.destroyed) this.dispatchNow();
        return;
      }

      // Job result — route by jobId to the right active slot.
      const result = message as WorkerResult;
      const state = getState(worker);
      const jobId = result.jobId;
      let slot: ActiveSlot | undefined;
      if (jobId !== undefined) {
        slot = state.active.get(jobId);
        if (slot) state.active.delete(jobId);
      } else if (state.active.size === 1) {
        // Concurrency == 1 back-compat: single in-flight job, no need for ID.
        const it = state.active.values().next();
        slot = it.value as ActiveSlot | undefined;
        state.active.clear();
      }
      if (!slot) return; // late message for an aborted/timed-out task
      this.completeJob(worker, slot, result);
      if (!this.destroyed) this.dispatchNow();
    };

    worker.on('message', onMessage);
    worker.once('error', (err) => this.handleWorkerError(worker, err));
    worker.once('exit', (code) => this.handleWorkerExit(worker, code));
    return worker;
  }

  private handleIpcInvoke(worker: Worker, req: IpcInvokeRequest): void {
    const svcInstance = this.proxyMap.get(req.propertyKey);
    const reply = (res: IpcInvokeResponse) => {
      try {
        worker.postMessage(res);
      } catch {
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
      reply({
        type: 'ipc:result', callId: req.callId, ok: false,
        error: `No proxy registered for "${req.propertyKey}"`,
      });
      return;
    }
    const method = svcInstance[req.methodName];
    if (typeof method !== 'function') {
      reply({
        type: 'ipc:result', callId: req.callId, ok: false,
        error: `Method "${req.methodName}" not found on "${req.propertyKey}"`,
      });
      return;
    }
    let p: unknown;
    try {
      p = svcInstance[req.methodName](...(req.args as unknown[]));
    } catch (err: unknown) {
      reply({
        type: 'ipc:result', callId: req.callId, ok: false,
        error: (err as Error).message ?? String(err),
      });
      return;
    }
    // Sync fast path for proxies that return plain values.
    if (p === null || typeof p !== 'object' || typeof (p as { then?: unknown }).then !== 'function') {
      reply({ type: 'ipc:result', callId: req.callId, ok: true, data: p });
      return;
    }
    Promise.resolve(p).then(
      (data) => reply({ type: 'ipc:result', callId: req.callId, ok: true, data }),
      (err: unknown) => reply({
        type: 'ipc:result', callId: req.callId, ok: false,
        error: (err as Error).message ?? String(err),
      }),
    );
  }

  private enqueue(task: PendingTask): void {
    const weight = PRIORITY_WEIGHT[task.priority];
    const q = this.queue;
    const head = this.queueHead;
    const n = q.length;
    // Fast path: empty queue, or tail has >= priority → just push (O(1)).
    // This is by far the most common case under steady-state load.
    if (n === head || PRIORITY_WEIGHT[q[n - 1].priority] >= weight) {
      q.push(task);
      return;
    }
    // Binary search over the live region [head, n) for the insertion point.
    let lo = head, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (PRIORITY_WEIGHT[q[mid].priority] < weight) hi = mid;
      else lo = mid + 1;
    }
    q.splice(lo, 0, task);
  }

  private schedule(): void {
    if (this.destroyed || this.scheduleQueued) return;
    if (this.idle.length === 0 || this.queueHead >= this.queue.length) return;
    this.scheduleQueued = true;
    queueMicrotask(this.drain);
  }

  /**
   * Synchronous drain used on the COMPLETION path — when a worker becomes
   * idle as a result of a result message arriving, we want to hand it the
   * next queued job in the SAME tick. The microtask-deferred `schedule()`
   * adds a full microtask hop per round-trip, which dominates throughput
   * for short tasks with concurrency=1.
   *
   * Initial-burst dispatch still goes through the deferred `schedule()` so
   * synchronous floods of `execute()` calls get coalesced into per-worker
   * batches.
   */
  private dispatchNow(): void {
    if (this.destroyed) return;
    const idle = this.idle;
    const q = this.queue;
    // If a microtask drain is already queued (initial burst still in flight),
    // let it own the dispatch — running both would race and double-dispatch.
    if (this.scheduleQueued) return;
    if (idle.length === 0 || this.queueHead >= q.length) return;

    let batches: Map<Worker, WorkerJob[]> | undefined;
    while (idle.length > 0 && this.queueHead < q.length) {
      const worker = idle.pop()!;
      const task = q[this.queueHead]!;
      (q as unknown as (PendingTask | undefined)[])[this.queueHead] = undefined;
      this.queueHead++;
      if (this.queueHead > 1024 && this.queueHead * 2 > q.length) {
        q.splice(0, this.queueHead);
        this.queueHead = 0;
      }
      this.prepareDispatch(worker, task);
      // Fast path for the overwhelmingly common case: ONE worker idle,
      // ONE job to dispatch. Skip the Map allocation and ship directly.
      if (batches === undefined && (idle.length === 0 || this.queueHead >= q.length)) {
        worker.postMessage(task.job);
        return;
      }
      if (batches === undefined) batches = new Map();
      let arr = batches.get(worker);
      if (arr === undefined) { arr = []; batches.set(worker, arr); }
      arr.push(task.job);
    }
    if (batches === undefined) return;
    for (const [worker, jobs] of batches) {
      if (jobs.length === 1) {
        worker.postMessage(jobs[0]);
      } else {
        worker.postMessage({ type: 'batch', jobs } satisfies WorkerJobBatch);
      }
    }
  }

  /** Pre-bound for queueMicrotask — avoids closure allocation per schedule. */
  private readonly drain = (): void => {
    this.scheduleQueued = false;
    if (this.destroyed) return;
    const idle = this.idle;
    const q = this.queue;
    // Collect per-worker dispatches built during this schedule pass so we
    // can ship them in ONE postMessage envelope per worker. Each postMessage
    // pays a fixed structuredClone setup cost — batching amortises it.
    let batches: Map<Worker, WorkerJob[]> | undefined;
    while (idle.length > 0 && this.queueHead < q.length) {
      const worker = idle.pop()!;
      const task = q[this.queueHead]!;
      (q as unknown as (PendingTask | undefined)[])[this.queueHead] = undefined;
      this.queueHead++;
      if (this.queueHead > 1024 && this.queueHead * 2 > q.length) {
        q.splice(0, this.queueHead);
        this.queueHead = 0;
      }
      this.prepareDispatch(worker, task);
      if (!batches) batches = new Map();
      let arr = batches.get(worker);
      if (!arr) { arr = []; batches.set(worker, arr); }
      arr.push(task.job);
    }
    if (!batches) return;
    for (const [worker, jobs] of batches) {
      if (jobs.length === 1) {
        worker.postMessage(jobs[0]);
      } else {
        worker.postMessage({ type: 'batch', jobs } satisfies WorkerJobBatch);
      }
    }
  };

  private prepareDispatch(worker: Worker, task: PendingTask): void {
    // Only pay the syscall cost when someone is actually listening.
    const wantTiming =
      this.listenerCount('taskEnd') > 0 || this.listenerCount('taskStart') > 0;
    const startedAt = wantTiming ? Date.now() : 0;

    task.attempts++;

    const sigId = task.job.abortSignalId;
    if (sigId !== undefined) {
      this.signalWorkerMap.set(sigId, worker);
    }

    const slot: ActiveSlot = { task, startedAt, settled: false };
    const state = getState(worker);
    state.active.set(task.job.jobId, slot);
    this.activeCount++;

    if (this.listenerCount('taskStart') > 0) this.emit('taskStart', task.job);

    if (task.timeout && task.timeout > 0) {
      slot.timeoutHandle = setTimeout(() => this.handleTimeout(worker, slot), task.timeout);
    }
  }

  /** Called from the persistent message listener when a job result arrives. */
  private completeJob(worker: Worker, slot: ActiveSlot, result: WorkerResult): void {
    if (slot.settled) return;
    slot.settled = true;
    if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
    const sigId = slot.task.job.abortSignalId;
    if (sigId !== undefined) this.signalWorkerMap.delete(sigId);
    this.activeCount--;

    if (result.ok) {
      if (this.listenerCount('taskEnd') > 0 && slot.startedAt > 0) {
        this.emit('taskEnd', slot.task.job, Date.now() - slot.startedAt);
      }
      slot.task.resolve(result.data);
    } else {
      this.handleFailure(slot.task, result.error ?? {
        name: 'Error',
        message: 'Unknown worker error',
      });
    }

    // Give the slot back to the pool. Scheduling is the *caller*'s job so
    // batched-result paths can release N slots before re-scheduling — that
    // way schedule() can batch N new dispatches into a single postMessage
    // back to the worker.
    if (!this.destroyed) {
      this.idle.push(worker);
    }
  }

  private handleFailure(task: PendingTask, serializedError: SerializedError): void {
    const retry = task.retry ?? 0;
    const retryDelay = task.retryDelay ?? 0;
    if (this.listenerCount('taskError') > 0) {
      this.emit('taskError', task.job, serializedError);
    }

    if (task.attempts < retry + 1) {
      const scheduleRetry = () => {
        this.enqueue(task);
        this.schedule();
      };
      if (retryDelay > 0) setTimeout(scheduleRetry, retryDelay);
      else scheduleRetry();
      return;
    }

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
  }

  private async handleTimeout(worker: Worker, slot: ActiveSlot): Promise<void> {
    if (slot.settled) return;
    slot.settled = true;
    const sigId = slot.task.job.abortSignalId;
    if (sigId !== undefined) this.signalWorkerMap.delete(sigId);
    const state = getState(worker);
    state.active.delete(slot.task.job.jobId);
    this.activeCount--;

    this.handleFailure(slot.task, {
      name: 'TimeoutError',
      message: `Task "${slot.task.job.serviceName}.${slot.task.job.methodName}" ` +
        `timed out after ${slot.task.timeout}ms`,
    });

    // Timeouts terminate the worker (its event loop may be wedged) and
    // replace it. All other in-flight jobs on this worker fail too.
    try {
      await worker.terminate();
    } catch { /* ignore */ }
    this.replaceWorker(worker);
    this.schedule();
  }

  private handleWorkerError(worker: Worker, err: Error): void {
    const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
    if (state) {
      for (const slot of state.active.values()) {
        if (slot.settled) continue;
        slot.settled = true;
        if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
        const sigId = slot.task.job.abortSignalId;
        if (sigId !== undefined) this.signalWorkerMap.delete(sigId);
        const { serviceName, methodName } = slot.task.job;
        const wrapped = new Error(`Worker crashed in "${serviceName}.${methodName}": ${err.message}`);
        wrapped.stack = err.stack;
        this.emit('error', wrapped, slot.task.job);
        slot.task.reject(wrapped);
        this.activeCount--;
      }
      state.active.clear();
    }
    this.replaceWorker(worker);
  }

  private handleWorkerExit(worker: Worker, code: number): void {
    if (this.destroyed) return;
    const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
    if (state) {
      for (const slot of state.active.values()) {
        if (slot.settled) continue;
        slot.settled = true;
        if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
        const sigId = slot.task.job.abortSignalId;
        if (sigId !== undefined) this.signalWorkerMap.delete(sigId);
        slot.task.reject(new Error(
          `Worker exited with code ${code} while running ` +
          `"${slot.task.job.serviceName}.${slot.task.job.methodName}"`,
        ));
        this.activeCount--;
      }
      state.active.clear();
    }
    this.replaceWorker(worker);
  }

  private replaceWorker(oldWorker: Worker): void {
    const remove = (arr: Worker[]) => {
      // Remove ALL occurrences (idle holds up to `concurrency` slots per worker).
      let w = 0;
      for (let r = 0; r < arr.length; r++) {
        if (arr[r] !== oldWorker) arr[w++] = arr[r];
      }
      arr.length = w;
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
    if (this.activeCount > 0) {
      const activeTasks: PendingTask[] = [];
      for (const worker of this.workers) {
        const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
        if (!state) continue;
        for (const slot of state.active.values()) activeTasks.push(slot.task);
      }
      await Promise.race([
        Promise.allSettled(
          activeTasks.map(
            (task) => new Promise<void>((res) => {
              const orig = task.resolve;
              const origRej = task.reject;
              task.resolve = (v) => {
                orig(v);
                res();
              };
              task.reject = (e) => {
                origRej(e);
                res();
              };
            }),
          ),
        ),
        new Promise<void>((res) => setTimeout(res, this.shutdownTimeout)),
      ]);
    }

    // Reject anything still queued
    for (let i = this.queueHead; i < this.queue.length; i++) {
      const queued = this.queue[i];
      if (queued) queued.reject(new Error('WorkerPool destroyed'));
    }
    this.queue.length = 0;
    this.queueHead = 0;

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
