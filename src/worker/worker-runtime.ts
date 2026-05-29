import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkerContainer } from '../di/worker-container';
import type { SerializedService } from '../di/worker-container';
import type {
  WorkerJob,
  WorkerJobBatch,
  WorkerResult,
  WorkerResultBatch,
  WorkerInboundMessage,
  WorkerAbortMessage,
  IpcInvokeRequest,
  IpcInvokeResponse,
  ProxyServiceDescriptor,
  SerializedError,
} from '../core/worker.interfaces';

const services: SerializedService[] = workerData?.services ?? [];
const container = new WorkerContainer();

type ServiceInstance = Record<string, (...args: unknown[]) => unknown>;

const instances = new Map<string, ServiceInstance>();
const servicesByName = new Map<string, SerializedService>();
for (const svc of services) servicesByName.set(svc.name, svc);

function getInstance(name: string): ServiceInstance | undefined {
  let inst = instances.get(name);
  if (inst !== undefined) return inst;
  const svc = servicesByName.get(name);
  if (svc === undefined) return undefined;
  container.load([svc]);
  inst = container.get<ServiceInstance>(svc.name);
  instances.set(svc.name, inst);
  return inst;
}

const port = parentPort!;
port.postMessage({ type: 'worker:ready' });

// ── Pending IPC calls ─────────────────────────────────────────────────────
const pendingIpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// ── Pending AbortControllers (keyed by abortSignalId) ────────────────────
const pendingAborts = new Map<number, AbortController>();

/**
 * abortSignalId of the task currently being dispatched on this microtask.
 * `buildProxy` reads it so that proxy IPC requests can forward the parent
 * task's abort id to the main thread, allowing proxy methods to receive
 * the originating AbortSignal as their last argument.
 *
 * Set in `runJob` immediately before invoking the task, cleared in the
 * settle paths. Proxy calls scheduled synchronously inside the task body
 * (or in micro/macrotasks chained off it) inherit this id automatically.
 */
let currentAbortId: number | undefined;

// ── ALS for context propagation ──────────────────────────────────────────
// The shape mirrors the WorkerModuleOptions.asyncLocalStorages array order.
// Stored as `unknown[]` (not `Record<string, unknown>`) so >10 storages
// work and the structuredClone payload is smaller.
const workerAls = new AsyncLocalStorage<unknown[]>();

const proxyCache = new Map<string, ServiceInstance>();
const proxiesInstalled = new WeakMap<ServiceInstance, Set<string>>();

port.on('message', (msg: unknown) => {
  const message = msg as WorkerInboundMessage;
  const t = (message as { type?: string }).type;

  if (t === 'ipc:result') {
    const res = message as IpcInvokeResponse;
    const pending = pendingIpc.get(res.callId);
    if (!pending) return;
    pendingIpc.delete(res.callId);
    res.ok ? pending.resolve(res.data) : pending.reject(new Error(res.error ?? 'IPC failed'));
    return;
  }

  if (t === 'abort') {
    const abort = message as WorkerAbortMessage;
    pendingAborts.get(abort.abortSignalId)?.abort();
    return;
  }

  if (t === 'batch') {
    const batch = message as WorkerJobBatch;
    const jobs = batch.jobs;
    forceBuffer = true;
    try {
      for (let i = 0; i < jobs.length; i++) runJob(jobs[i]);
    } finally {
      forceBuffer = false;
    }
    if (resultBuffer.length > 0) {
      flushScheduled = true;
      flushResults();
    }
    return;
  }

  runJob(message as WorkerJob);
});

function buildProxy(descriptor: ProxyServiceDescriptor): ServiceInstance {
  const cached = proxyCache.get(descriptor.propertyKey);
  if (cached) return cached;
  const proxy: ServiceInstance = {};
  const propertyKey = descriptor.propertyKey;
  for (const methodName of descriptor.methodNames) {
    proxy[methodName] = (...args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const callId = ++__callCounter;
        pendingIpc.set(callId, { resolve, reject });
        const request: IpcInvokeRequest = {
          type: 'ipc:invoke',
          callId,
          propertyKey,
          methodName,
          args,
        };
        // Propagate the originating task's abortSignalId so the main thread
        // can supply a live AbortSignal to the proxy method implementation.
        if (currentAbortId !== undefined) request.abortSignalId = currentAbortId;
        try {
          port.postMessage(request);
        } catch (err: unknown) {
          pendingIpc.delete(callId);
          reject(
            new Error(
              `IPC proxy "${propertyKey}.${methodName}" could not serialise args: ` +
                `${(err as Error).message}`,
            ),
          );
        }
      });
  }
  proxyCache.set(descriptor.propertyKey, proxy);
  return proxy;
}

let __callCounter = 0;

// ── Outgoing result batching ─────────────────────────────────────────────
const resultBuffer: WorkerResult[] = [];
let flushScheduled = false;
let forceBuffer = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushResults);
}

function flushResults(): void {
  flushScheduled = false;
  const n = resultBuffer.length;
  if (n === 0) return;
  if (n === 1) {
    const only = resultBuffer[0];
    resultBuffer.length = 0;
    port.postMessage(only);
    return;
  }
  const batch: WorkerResultBatch = {
    type: 'results',
    results: resultBuffer.slice(0, n),
  };
  resultBuffer.length = 0;
  port.postMessage(batch);
}

function postResult(res: WorkerResult): void {
  if (!forceBuffer && !flushScheduled && resultBuffer.length === 0) {
    port.postMessage(res);
    return;
  }
  resultBuffer.push(res);
  scheduleFlush();
}

function runJob(job: WorkerJob): void {
  const jobId = job.jobId;
  const inst = getInstance(job.serviceName);
  if (!inst) {
    postError(jobId, new Error(`Service "${job.serviceName}" is not registered`));
    return;
  }

  const proxyServices = job.proxyServices;
  if (proxyServices !== undefined && proxyServices.length > 0) {
    let installed = proxiesInstalled.get(inst);
    if (!installed) {
      installed = new Set();
      proxiesInstalled.set(inst, installed);
    }
    for (let i = 0; i < proxyServices.length; i++) {
      const d = proxyServices[i];
      if (!installed.has(d.propertyKey)) {
        inst[d.propertyKey] = buildProxy(d) as unknown as (...args: unknown[]) => unknown;
        installed.add(d.propertyKey);
      }
    }
  }

  const fn = inst[job.methodName];
  if (typeof fn !== 'function') {
    postError(jobId, new Error(`Task "${job.serviceName}.${job.methodName}" is not registered`));
    return;
  }

  const abortSignalId = job.abortSignalId;
  const args = job.args;
  let callArgs: unknown[] = args;
  if (abortSignalId !== undefined) {
    const abortController = new AbortController();
    pendingAborts.set(abortSignalId, abortController);
    callArgs = [...args, abortController.signal];
  }

  const settle = (): void => {
    if (abortSignalId !== undefined) pendingAborts.delete(abortSignalId);
    if (currentAbortId === abortSignalId) currentAbortId = undefined;
  };

  // Track the active task's abort id so synchronously-launched proxy calls
  // can forward it. Restored after the synchronous portion of the task runs.
  const prevAbortId = currentAbortId;
  currentAbortId = abortSignalId;

  try {
    const alsContext = job.alsContext;
    let result: unknown;
    if (alsContext === undefined) {
      result = (fn as (...a: unknown[]) => unknown).apply(inst, callArgs);
    } else {
      result = workerAls.run(alsContext, () =>
        (fn as (...a: unknown[]) => unknown).apply(inst, callArgs),
      );
    }

    if (
      result === null ||
      typeof result !== 'object' ||
      typeof (result as { then?: unknown }).then !== 'function'
    ) {
      settle();
      postResult({ type: 'result', ok: true, data: result, jobId });
      return;
    }
    // Async return — keep currentAbortId set across the .then so proxy calls
    // scheduled in microtasks chained off the task body still see it.
    // (`currentAbortId` is only used synchronously by proxy methods at the
    // moment they are CALLED, not when they postMessage.)
    (result as Promise<unknown>).then(
      (data) => {
        settle();
        postResult({ type: 'result', ok: true, data, jobId });
      },
      (error: unknown) => {
        settle();
        postError(jobId, error);
      },
    );
  } catch (error: unknown) {
    settle();
    postError(jobId, error);
  } finally {
    // Restore the outer abort id so back-to-back synchronous runJob calls
    // (from a batch) don't leak ids into each other's proxy invocations.
    currentAbortId = prevAbortId;
  }
}

function postError(jobId: number, error: unknown): void {
  const e = error as Error & { code?: string | number; [key: string]: unknown };
  const serialized: SerializedError = {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(error),
    stack: e?.stack,
    code: e?.code,
    extra: serializeExtraProps(e),
  };
  postResult({ type: 'result', ok: false, error: serialized, jobId });
}

function serializeExtraProps(
  err: Error & Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const skip = SKIP_ERR_KEYS;
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const key of Object.keys(err)) {
    if (skip.has(key)) continue;
    extra[key] = err[key];
    hasExtra = true;
  }
  if (!hasExtra) return undefined;
  try {
    structuredClone(extra);
    return extra;
  } catch {
    const safe: Record<string, unknown> = {};
    let kept = false;
    for (const key of Object.keys(extra)) {
      try {
        structuredClone(extra[key]);
        safe[key] = extra[key];
        kept = true;
      } catch {
        /* skip */
      }
    }
    return kept ? safe : undefined;
  }
}

const SKIP_ERR_KEYS = new Set(['name', 'message', 'stack', 'code']);
