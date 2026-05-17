import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';

import type {
  WorkerJob,
  WorkerResult,
  TaskPriority,
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
};

type RunningTask = {
  worker: Worker;
  task: PendingTask;
  priority: TaskPriority;
};

export class WorkerPool {
  private readonly workers: Worker[] = [];

  private readonly idle: Worker[] = [];

  private readonly queue: PendingTask[] = [];

  private destroyed = false;
  private readonly active =
    new Map<Worker, RunningTask>();

  constructor(
    private readonly services: SerializedService[],
    private readonly size = os.cpus().length,
  ) {
    for (let i = 0; i < this.size; i++) {
      const worker = this.spawnWorker();

      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  execute<T = unknown>(job: WorkerJob): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(
        new Error('WorkerPool destroyed'),
      );
    }

    return new Promise<T>(async (resolve, reject) => {
      const task: PendingTask = {
        job,
        resolve: resolve as (v: unknown) => void,
        reject,
      };

      await this.preemptIfNeeded(task);
      // ALWAYS enqueue first
      // otherwise priority is bypassed
      this.enqueue(task);

      // process queue
      this.schedule();
    });
  }

  private async preemptIfNeeded(
    incoming: PendingTask,
  ): Promise<boolean> {
    if (incoming.job.priority !== 'HIGH') {
      return false;
    }

    for (const [worker, running] of this.active) {
      if (running.priority === 'LOW') {
        // stop LOW task
        await worker.terminate();

        // requeue interrupted LOW task
        this.enqueue(running.task);

        // remove dead worker
        this.active.delete(worker);

        const idx =
          this.workers.indexOf(worker);

        if (idx >= 0) {
          this.workers.splice(idx, 1);
        }

        // create replacement worker
        const replacement =
          this.spawnWorker();

        this.workers.push(replacement);

        // dispatch HIGH immediately
        this.dispatch(
          replacement,
          incoming,
        );

        return true;
      }
    }

    return false;
  }

  private enqueue(task: PendingTask): void {
    const weight = PRIORITY_WEIGHT[task.job.priority];

    let lo = 0;
    let hi = this.queue.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;

      if (
        PRIORITY_WEIGHT[
          this.queue[mid].job.priority
          ] < weight
      ) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    this.queue.splice(lo, 0, task);
  }

  private schedule(): void {
    if (this.destroyed) return;

    while (
      this.idle.length > 0 &&
      this.queue.length > 0
      ) {
      const worker = this.idle.pop()!;

      // highest priority task first
      const task = this.queue.shift()!;

      this.dispatch(worker, task);
    }
  }

  private dispatch(
    worker: Worker,
    task: PendingTask,
  ): void {
    let settled = false;

    let timeoutHandle: NodeJS.Timeout | undefined;

    const cleanup = () => {
      worker.removeListener(
        'message',
        onMessage,
      );

      worker.removeListener(
        'error',
        onError,
      );

      worker.removeListener(
        'exit',
        onExit,
      );

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const recycle = () => {
      cleanup();

      if (this.destroyed) return;

      this.idle.push(worker);

      // continue processing
      this.schedule();
    };

    const settle = (
      fn: () => void | Promise<void>,
    ) => {
      if (settled) return;

      settled = true;

      Promise.resolve(fn())
        .catch(() => {})
        .finally(() => {
          recycle();
        });
    };

    const onMessage = (
      result: WorkerResult,
    ) => {
      settle(() => {
        if (result.ok) {
          task.resolve(result.data);
        } else {
          task.reject(
            new Error(
              result.error?.message ??
              'Worker error',
            ),
          );
        }
      });
    };

    const onError = async (err: Error) => {
      settle(async () => {
        task.reject(err);

        await this.replaceWorker(worker);
      });
    };

    const onExit = async (code: number) => {
      if (this.destroyed) return;

      settle(async () => {
        task.reject(
          new Error(
            `Worker exited unexpectedly with code ${code} ` +
            `while running "${task.job.serviceName}.${task.job.methodName}"`,
          ),
        );

        await this.replaceWorker(worker);
      });
    };

    worker.once('message', onMessage);

    worker.once('error', onError);

    worker.once('exit', onExit);

    if (
      task.job.timeout &&
      task.job.timeout > 0
    ) {
      timeoutHandle = setTimeout(async () => {
        if (settled) return;

        settled = true;

        cleanup();

        task.reject(
          new Error(
            `Task "${task.job.serviceName}.${task.job.methodName}" timed out after ${task.job.timeout}ms`,
          ),
        );

        try {
          await worker.terminate();
        } catch {}

        await this.replaceWorker(worker);

        this.schedule();
      }, task.job.timeout);
    }

    worker.postMessage(task.job);
  }

  private spawnWorker(): Worker {
    return new Worker(
      path.resolve(
        __dirname,
        '../worker/worker-runtime.js',
      ),
      {
        workerData: {
          services: this.services,
        },
      },
    );
  }

  private async replaceWorker(
    oldWorker: Worker,
  ): Promise<void> {
    const workerIndex =
      this.workers.indexOf(oldWorker);

    if (workerIndex >= 0) {
      this.workers.splice(workerIndex, 1);
    }

    const idleIndex =
      this.idle.indexOf(oldWorker);

    if (idleIndex >= 0) {
      this.idle.splice(idleIndex, 1);
    }

    const newWorker = this.spawnWorker();

    this.workers.push(newWorker);

    this.idle.push(newWorker);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;

    for (const queued of this.queue) {
      queued.reject(
        new Error('WorkerPool destroyed'),
      );
    }

    this.queue.length = 0;

    await Promise.allSettled(
      this.workers.map((worker) =>
        worker.terminate(),
      ),
    );

    this.workers.length = 0;
    this.idle.length = 0;
  }
}