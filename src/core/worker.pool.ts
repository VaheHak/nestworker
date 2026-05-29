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

/** Cross-version AbortError factory (DOMException only since Node 17). */
function makeAbortError(message: string): Error {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export class QueueFullError extends Error {
  constructor(depth: number) {
    super(`WorkerPool queue is full (maxQueueDepth=${depth})`);
    this.name = 'QueueFullError';
  }
}

type PendingTask = {
  job: WorkerJob;
  /** Priority is main-thread-only (queue ordering) — kept off the wire. */
  priority: TaskPriority;
  /** Timeout / retry policy is main-thread-only too. */
  timeout?: number;
  retry?: number;
  /** Numeric delay, or a function `(attempt) => ms` evaluated main-side. */
  retryDelay?: number | ((attempt: number) => number);
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  /** Attempts already made (0 = never tried) */
  attempts: number;
  /** AbortSignal supplied by the caller */
  signal?: AbortSignal;
  /** Bound abort listener — removed on settle to avoid leaking on shared signals. */
  abortHandler?: () => void;
  /** Worker currently executing this task (set in prepareDispatch). */
  worker?: Worker;
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
  /** True once replaceWorker has fired — guards against duplicate error+exit. */
  replaced: boolean;
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
  // Per-priority FIFO buckets. Replaces the single sorted queue: enqueue is
  // now O(1) push (no binary search + splice), dequeue is O(1) pop from the
  // highest non-empty bucket. Long bursts of mixed-priority jobs no longer
  // pay an O(n) shift cost.
  private readonly queueHigh: Array<PendingTask | undefined> = [];
  private readonly queueNormal: Array<PendingTask | undefined> = [];
  private readonly queueLow: Array<PendingTask | undefined> = [];
  private queueHighHead = 0;
  private queueNormalHead = 0;
  private queueLowHead = 0;
  private queuedCount = 0;
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

  private readonly concurrency: number;
  private readonly maxQueueDepth: number;

  private readonly proxyMap = new Map<string, Record<string, (...args: unknown[]) => unknown>>();

  constructor(
    private readonly services: SerializedService[],
    proxyInstances: ProxyInstance[],
    private readonly size = os.cpus().length,
    private readonly shutdownTimeout = 30_000,
    concurrency = 1,
    maxQueueDepth = Number.POSITIVE_INFINITY,
  ) {
    super();
    this.concurrency = concurrency > 0 ? concurrency : 1;
    this.maxQueueDepth = maxQueueDepth > 0 ? maxQueueDepth : Number.POSITIVE_INFINITY;
    for (const { propertyKey, instance } of proxyInstances) {
      this.proxyMap.set(propertyKey, instance);
    }
    for (let i = 0; i < this.size; i++) {
      this.spawnWorker();
    }
  }

  execute<T = unknown>(
    job: WorkerJob,
    meta: {
      priority: TaskPriority;
      timeout?: number;
      retry?: number;
      retryDelay?: number | ((attempt: number) => number);
    },
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('WorkerPool destroyed'));

    return new Promise<T>((resolve, reject) => {
      // Reject immediately if already aborted
      if (signal?.aborted) {
        reject(makeAbortError('Task aborted before enqueue'));
        return;
      }

      // Backpressure: enforce queue depth before allocating anything.
      const depth = this.queuedCount;
      if (depth >= this.maxQueueDepth) {
        reject(new QueueFullError(this.maxQueueDepth));
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
        const handler = (): void => {
          // Tombstone the task in its bucket if it's still queued. We don't
          // know which bucket it lives in without checking, so try each;
          // each scan walks ONLY the live region (head..length) of its
          // bucket. In the worst case the task isn't queued at all (already
          // dispatched), so we fall through to the running-task path.
          const buckets: Array<[Array<PendingTask | undefined>, number]> = [
            [this.queueHigh, this.queueHighHead],
            [this.queueNormal, this.queueNormalHead],
            [this.queueLow, this.queueLowHead],
          ];
          for (const [bucket, head] of buckets) {
            for (let i = head; i < bucket.length; i++) {
              if (bucket[i] === task) {
                bucket[i] = undefined;
                this.queuedCount--;
                this.detachAbort(task);
                reject(makeAbortError('Task aborted'));
                return;
              }
            }
          }
          // Already running — forward abort to its worker.
          const worker = task.worker;
          if (worker && job.abortSignalId !== undefined) {
            try {
              worker.postMessage({
                type: 'abort',
                abortSignalId: job.abortSignalId,
              });
            } catch {
              /* worker gone */
            }
          }
        };
        task.abortHandler = handler;
        signal.addEventListener('abort', handler, { once: true });
      }

      this.enqueue(task);
      this.schedule();
    });
  }

  /** Remove the abort listener installed in `execute()` (idempotent). */
  private detachAbort(task: PendingTask): void {
    if (task.abortHandler && task.signal) {
      try {
        task.signal.removeEventListener('abort', task.abortHandler);
      } catch {
        /* ignore */
      }
      task.abortHandler = undefined;
    }
  }

  stats(): PoolStats {
    const queued = this.queuedCount;
    const cap = this.maxQueueDepth;
    return {
      poolSize: this.size,
      idle: this.idle.length,
      busy: this.activeCount,
      queued,
      warmingUp: this.warmingUp.size,
      saturation: Number.isFinite(cap) ? queued / cap : 0,
      maxQueueDepth: cap,
    };
  }

  private spawnWorker(): Worker {
    const worker = new Worker(path.resolve(__dirname, '../worker/worker-runtime.js'), {
      workerData: { services: this.services },
    });
    (worker as unknown as { [STATE]: WorkerState })[STATE] = {
      active: new Map(),
      replaced: false,
    };
    this.workers.push(worker);
    this.warmingUp.add(worker);

    // ── Single persistent message listener ───────────────────────────────
    const onMessage = (msg: unknown) => {
      const message = msg as { type?: string };

      if (this.warmingUp.has(worker)) {
        if (message?.type !== 'worker:ready') return;
        this.warmingUp.delete(worker);
        if (!this.destroyed) {
          for (let i = 0; i < this.concurrency; i++) this.idle.push(worker);
          this.schedule();
        }
        return;
      }

      // Spurious `worker:ready` after warmup → ignore.
      if (message?.type === 'worker:ready') return;

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
          if (r.jobId === undefined) continue;
          const slot = state.active.get(r.jobId);
          if (!slot) continue;
          state.active.delete(r.jobId);
          this.completeJob(worker, slot, r);
        }
        if (!this.destroyed) this.dispatchNow();
        return;
      }

      // Single job result — route by jobId.
      const result = message as WorkerResult;
      if (result.jobId === undefined) return;
      const state = getState(worker);
      const slot = state.active.get(result.jobId);
      if (!slot) return; // late message for an aborted/timed-out task
      state.active.delete(result.jobId);
      this.completeJob(worker, slot, result);
      if (!this.destroyed) this.dispatchNow();
    };

    worker.on('message', onMessage);
    // Use .on (not .once): a wedged worker can emit multiple errors before
    // exit. handleWorkerError is idempotent via WorkerState.replaced.
    worker.on('error', (err) => this.handleWorkerError(worker, err));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));
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
            type: 'ipc:result',
            callId: res.callId,
            ok: false,
            error:
              `IPC result for "${req.propertyKey}.${req.methodName}" ` +
              `is not structuredClone-compatible.`,
          } satisfies IpcInvokeResponse);
        } catch {
          /* worker gone */
        }
      }
    };
    if (!svcInstance) {
      reply({
        type: 'ipc:result',
        callId: req.callId,
        ok: false,
        error: `No proxy registered for "${req.propertyKey}"`,
      });
      return;
    }
    const method = svcInstance[req.methodName];
    if (typeof method !== 'function') {
      reply({
        type: 'ipc:result',
        callId: req.callId,
        ok: false,
        error: `Method "${req.methodName}" not found on "${req.propertyKey}"`,
      });
      return;
    }
    // Forward the originating task's AbortSignal as the last arg when the
    // worker provided one — lets proxy implementations honour cancellation
    // (fetch, child_process, etc.) instead of running past it.
    let callArgs: unknown[] = req.args;
    if (req.abortSignalId !== undefined) {
      const sig = this.findSignalById(req.abortSignalId);
      if (sig) callArgs = [...req.args, sig];
    }
    let p: unknown;
    try {
      p = (method as (...a: unknown[]) => unknown).apply(svcInstance, callArgs);
    } catch (err: unknown) {
      reply({
        type: 'ipc:result',
        callId: req.callId,
        ok: false,
        error: (err as Error).message ?? String(err),
      });
      return;
    }
    // Sync fast path for proxies that return plain values.
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof (p as { then?: unknown }).then !== 'function'
    ) {
      reply({ type: 'ipc:result', callId: req.callId, ok: true, data: p });
      return;
    }
    Promise.resolve(p).then(
      (data) => reply({ type: 'ipc:result', callId: req.callId, ok: true, data }),
      (err: unknown) =>
        reply({
          type: 'ipc:result',
          callId: req.callId,
          ok: false,
          error: (err as Error).message ?? String(err),
        }),
    );
  }

  /**
   * Look up the original caller's AbortSignal by abortSignalId. Used by
   * `handleIpcInvoke` to forward cancellation into proxy methods.
   * Scan is bounded by `concurrency * poolSize` and only happens on proxy
   * calls from signal-bearing tasks, so we don't bother with a side index.
   */
  private findSignalById(abortSignalId: number): AbortSignal | undefined {
    for (const worker of this.workers) {
      const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
      if (!state) continue;
      for (const slot of state.active.values()) {
        if (slot.task.job.abortSignalId === abortSignalId) return slot.task.signal;
      }
    }
    return undefined;
  }

  private enqueue(task: PendingTask): void {
    const bucket =
      task.priority === 'HIGH'
        ? this.queueHigh
        : task.priority === 'LOW'
          ? this.queueLow
          : this.queueNormal;
    bucket.push(task);
    this.queuedCount++;
  }

  /**
   * Pop the next ready task in priority order (HIGH > NORMAL > LOW). Skips
   * tombstoned entries (aborted-while-queued) and lazily compacts each
   * bucket once its head pointer wastes >1024 slots.
   *
   * Returns `undefined` when all buckets are empty or contain only
   * tombstones — caller must check.
   */
  private dequeue(): PendingTask | undefined {
    // HIGH
    while (this.queueHighHead < this.queueHigh.length) {
      const t = this.queueHigh[this.queueHighHead];
      this.queueHigh[this.queueHighHead] = undefined;
      this.queueHighHead++;
      this.maybeCompact(this.queueHigh, 'queueHighHead');
      if (t) {
        this.queuedCount--;
        return t;
      }
    }
    // NORMAL
    while (this.queueNormalHead < this.queueNormal.length) {
      const t = this.queueNormal[this.queueNormalHead];
      this.queueNormal[this.queueNormalHead] = undefined;
      this.queueNormalHead++;
      this.maybeCompact(this.queueNormal, 'queueNormalHead');
      if (t) {
        this.queuedCount--;
        return t;
      }
    }
    // LOW
    while (this.queueLowHead < this.queueLow.length) {
      const t = this.queueLow[this.queueLowHead];
      this.queueLow[this.queueLowHead] = undefined;
      this.queueLowHead++;
      this.maybeCompact(this.queueLow, 'queueLowHead');
      if (t) {
        this.queuedCount--;
        return t;
      }
    }
    return undefined;
  }

  private maybeCompact(
    bucket: Array<PendingTask | undefined>,
    headProp: 'queueHighHead' | 'queueNormalHead' | 'queueLowHead',
  ): void {
    const head = this[headProp];
    if (head > 1024 && head * 2 > bucket.length) {
      bucket.splice(0, head);
      this[headProp] = 0;
    }
  }

  /** True iff at least one bucket has a non-tombstone entry remaining. */
  private hasQueued(): boolean {
    return this.queuedCount > 0;
  }

  private schedule(): void {
    if (this.destroyed || this.scheduleQueued) return;
    if (this.idle.length === 0 || !this.hasQueued()) return;
    this.scheduleQueued = true;
    queueMicrotask(this.drain);
  }

  /**
   * Synchronous drain used on the COMPLETION path. Initial-burst dispatch
   * still goes through the deferred `schedule()` so synchronous floods of
   * `execute()` calls get coalesced into per-worker batches.
   */
  private dispatchNow(): void {
    if (this.destroyed) return;
    // If a microtask drain is already queued, let it own the dispatch.
    if (this.scheduleQueued) return;
    this.flushDispatch(true);
  }

  /** Pre-bound for queueMicrotask — avoids closure allocation per schedule. */
  private readonly drain = (): void => {
    this.scheduleQueued = false;
    if (this.destroyed) return;
    this.flushDispatch(false);
  };

  /**
   * Common dispatch loop shared by `dispatchNow` (synchronous, post-result)
   * and `drain` (microtask, post-burst). Pops idle slots and ships jobs as
   * either bare `WorkerJob` (single) or `WorkerJobBatch` envelopes.
   *
   * @param fastSingle When true, take a fast path for "exactly one job to
   *   exactly one idle worker" that skips the per-worker Map allocation.
   */
  private flushDispatch(fastSingle: boolean): void {
    const idle = this.idle;
    if (idle.length === 0 || !this.hasQueued()) return;

    let batches: Map<Worker, WorkerJob[]> | undefined;
    while (idle.length > 0) {
      const task = this.dequeue();
      if (!task) break;
      const worker = idle.pop()!;
      this.prepareDispatch(worker, task);
      // Fast path: ONE worker idle, ONE job dispatched — ship immediately.
      if (fastSingle && batches === undefined && (idle.length === 0 || !this.hasQueued())) {
        this.safePostJob(worker, task, task.job);
        return;
      }
      if (batches === undefined) batches = new Map();
      let arr = batches.get(worker);
      if (arr === undefined) {
        arr = [];
        batches.set(worker, arr);
      }
      arr.push(task.job);
    }
    if (batches === undefined) return;
    for (const [worker, jobs] of batches) {
      if (jobs.length === 1) {
        const slot = getState(worker).active.get(jobs[0].jobId);
        this.safePostJob(worker, slot?.task, jobs[0]);
      } else {
        this.safePostBatch(worker, jobs);
      }
    }
  }

  /**
   * Post a single job; on serialization failure synthesise a failure result
   * so the caller's promise rejects instead of hanging on the active map.
   */
  private safePostJob(worker: Worker, task: PendingTask | undefined, job: WorkerJob): void {
    try {
      worker.postMessage(job);
    } catch (err: unknown) {
      const state = getState(worker);
      const slot = state.active.get(job.jobId);
      if (slot) {
        state.active.delete(job.jobId);
        this.completeJob(worker, slot, {
          type: 'result',
          ok: false,
          jobId: job.jobId,
          error: {
            name: 'DataCloneError',
            message:
              `Failed to postMessage job "${job.serviceName}.${job.methodName}": ` +
              ((err as Error).message ?? String(err)),
          },
        });
      } else if (task) {
        task.reject(err as Error);
      }
    }
  }

  private safePostBatch(worker: Worker, jobs: WorkerJob[]): void {
    try {
      worker.postMessage({ type: 'batch', jobs } satisfies WorkerJobBatch);
    } catch (err: unknown) {
      // Batch-level failure: fail every job in this batch individually.
      const state = getState(worker);
      const message = `Failed to postMessage batch: ` + ((err as Error).message ?? String(err));
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const slot = state.active.get(j.jobId);
        if (!slot) continue;
        state.active.delete(j.jobId);
        this.completeJob(worker, slot, {
          type: 'result',
          ok: false,
          jobId: j.jobId,
          error: { name: 'DataCloneError', message },
        });
      }
    }
  }

  private prepareDispatch(worker: Worker, task: PendingTask): void {
    const wantTiming = this.listenerCount('taskEnd') > 0 || this.listenerCount('taskStart') > 0;
    const startedAt = wantTiming ? Date.now() : 0;

    task.attempts++;
    task.worker = worker;

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
    this.activeCount--;

    if (result.ok) {
      if (this.listenerCount('taskEnd') > 0 && slot.startedAt > 0) {
        this.emit('taskEnd', slot.task.job, Date.now() - slot.startedAt);
      }
      this.detachAbort(slot.task);
      slot.task.worker = undefined;
      slot.task.resolve(result.data);
    } else {
      this.handleFailure(
        slot.task,
        result.error ?? {
          name: 'Error',
          message: 'Unknown worker error',
        },
      );
    }

    if (!this.destroyed) {
      this.idle.push(worker);
    }
  }

  private handleFailure(task: PendingTask, serializedError: SerializedError): void {
    const retry = task.retry ?? 0;
    if (this.listenerCount('taskError') > 0) {
      this.emit('taskError', task.job, serializedError);
    }

    if (task.attempts < retry + 1) {
      // Resolve retryDelay main-side: numeric value, or invoke fn(attempt).
      let delay = 0;
      const rd = task.retryDelay;
      if (typeof rd === 'number') delay = rd;
      else if (typeof rd === 'function') {
        try {
          delay = Math.max(0, Number(rd(task.attempts)) || 0);
        } catch {
          delay = 0;
        }
      }
      task.worker = undefined;
      const scheduleRetry = () => {
        if (this.destroyed) {
          task.reject(new Error('WorkerPool destroyed'));
          return;
        }
        this.enqueue(task);
        this.schedule();
      };
      if (delay > 0) setTimeout(scheduleRetry, delay);
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
    this.detachAbort(task);
    task.worker = undefined;
    task.reject(deserializeError(serializedError));
  }

  private async handleTimeout(worker: Worker, slot: ActiveSlot): Promise<void> {
    if (slot.settled) return;
    slot.settled = true;
    const state = getState(worker);
    state.active.delete(slot.task.job.jobId);
    this.activeCount--;

    // Terminate FIRST so the wedged worker is gone before any retry can be
    // scheduled (which would otherwise race back into a worker we're about
    // to destroy and either fail to dispatch or wedge again).
    try {
      await worker.terminate();
    } catch {
      /* ignore */
    }
    this.replaceWorker(worker);

    this.handleFailure(slot.task, {
      name: 'TimeoutError',
      message:
        `Task "${slot.task.job.serviceName}.${slot.task.job.methodName}" ` +
        `timed out after ${slot.task.timeout}ms`,
    });

    this.schedule();
  }

  private handleWorkerError(worker: Worker, err: Error): void {
    const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
    if (!state || state.replaced) return;
    state.replaced = true;
    for (const slot of state.active.values()) {
      if (slot.settled) continue;
      slot.settled = true;
      if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
      const { serviceName, methodName } = slot.task.job;
      const wrapped = new Error(`Worker crashed in "${serviceName}.${methodName}": ${err.message}`);
      wrapped.stack = err.stack;
      this.emit('error', wrapped, slot.task.job);
      this.detachAbort(slot.task);
      slot.task.worker = undefined;
      slot.task.reject(wrapped);
      this.activeCount--;
    }
    state.active.clear();
    this.replaceWorker(worker);
  }

  private handleWorkerExit(worker: Worker, code: number): void {
    if (this.destroyed) return;
    const state = (worker as unknown as { [STATE]?: WorkerState })[STATE];
    if (!state || state.replaced) return;
    state.replaced = true;
    for (const slot of state.active.values()) {
      if (slot.settled) continue;
      slot.settled = true;
      if (slot.timeoutHandle) clearTimeout(slot.timeoutHandle);
      this.detachAbort(slot.task);
      slot.task.worker = undefined;
      slot.task.reject(
        new Error(
          `Worker exited with code ${code} while running ` +
            `"${slot.task.job.serviceName}.${slot.task.job.methodName}"`,
        ),
      );
      this.activeCount--;
    }
    state.active.clear();
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

    // Drain: wait for all active jobs to finish, up to shutdownTimeout.
    // We track per-task settle Promises (created at execute-time) instead
    // of monkey-patching task.resolve/reject — that approach silently
    // dropped duplicate-settle calls and could deadlock the race.
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
            (task) =>
              new Promise<void>((res) => {
                const orig = task.resolve;
                const origRej = task.reject;
                let done = false;
                task.resolve = (v) => {
                  if (!done) {
                    done = true;
                    res();
                  }
                  orig(v);
                };
                task.reject = (e) => {
                  if (!done) {
                    done = true;
                    res();
                  }
                  origRej(e);
                };
              }),
          ),
        ),
        new Promise<void>((res) => setTimeout(res, this.shutdownTimeout)),
      ]);
    }

    // Reject anything still queued — walk each bucket and reject live entries.
    const drainBucket = (bucket: Array<PendingTask | undefined>, head: number): void => {
      for (let i = head; i < bucket.length; i++) {
        const queued = bucket[i];
        if (queued) {
          this.detachAbort(queued);
          queued.reject(new Error('WorkerPool destroyed'));
        }
      }
      bucket.length = 0;
    };
    drainBucket(this.queueHigh, this.queueHighHead);
    drainBucket(this.queueNormal, this.queueNormalHead);
    drainBucket(this.queueLow, this.queueLowHead);
    this.queueHighHead = this.queueNormalHead = this.queueLowHead = 0;
    this.queuedCount = 0;

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
