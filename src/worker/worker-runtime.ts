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
container.load(services);

type ServiceInstance = Record<string, (...args: unknown[]) => unknown>;

const instances = new Map<string, ServiceInstance>();
for (const svc of services) {
  instances.set(svc.name, container.get<ServiceInstance>(svc.name));
}

// Stash parentPort once — `parentPort` is a module getter; caching the
// reference avoids the getter call on every postMessage on the hot path.
const port = parentPort!;
port.postMessage({ type: 'worker:ready' });

// ── Pending IPC calls ─────────────────────────────────────────────────────
const pendingIpc = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

// ── Pending AbortControllers (keyed by abortSignalId) ────────────────────
const pendingAborts = new Map<number, AbortController>();

// ── Internal ALS for context propagation ─────────────────────────────────
const workerAls = new AsyncLocalStorage<Record<string, unknown>>();

// Cache built proxies per descriptor signature — proxy descriptors are
// static per service, but the previous code rebuilt them on every job and
// mutated the shared service instance each time. Cache by propertyKey.
const proxyCache = new Map<string, ServiceInstance>();
const proxiesInstalled = new Set<string>(); // `${serviceName}:${propertyKey}`

port.on('message', (msg: unknown) => {
  const message = msg as WorkerInboundMessage;
  const t = (message as { type?: string }).type;

  // IPC result from main thread
  if (t === 'ipc:result') {
    const res = message as IpcInvokeResponse;
    const pending = pendingIpc.get(res.callId);
    if (!pending) return;
    pendingIpc.delete(res.callId);
    res.ok ? pending.resolve(res.data) : pending.reject(new Error(res.error ?? 'IPC failed'));
    return;
  }

  // Abort signal from main thread
  if (t === 'abort') {
    const abort = message as WorkerAbortMessage;
    pendingAborts.get(abort.abortSignalId)?.abort();
    return;
  }

  // Batched jobs — process each. All sync-resolving results get auto-batched
  // back into a single results envelope via the result flush microtask.
  if (t === 'batch') {
    const batch = message as WorkerJobBatch;
    const jobs = batch.jobs;
    for (let i = 0; i < jobs.length; i++) runJob(jobs[i]);
    return;
  }

  // Single job — pool sends this when only one job was dispatched in the
  // schedule pass (no batching benefit to wrap a 1-element envelope).
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
        try {
          port.postMessage(request);
        } catch (err: unknown) {
          pendingIpc.delete(callId);
          reject(new Error(
            `IPC proxy "${propertyKey}.${methodName}" could not serialise args: ` +
            `${(err as Error).message}`,
          ));
        }
      });
  }
  proxyCache.set(descriptor.propertyKey, proxy);
  return proxy;
}

// Counter-based call IDs — far cheaper than crypto.randomUUID() and only
// need to be unique within this worker process. Numeric IDs clone faster
// and hash cheaper than strings.
let __callCounter = 0;

// ── Outgoing result batching ─────────────────────────────────────────────
//
// We accumulate results into a single envelope per microtask tick. When a
// batch of jobs is dispatched at once, their resolved Promises all fire on
// the same microtask drain; the flush microtask is scheduled at the first
// postResult call and runs AFTER every queued .then, so it captures the
// entire batch and sends it in ONE postMessage. This collapses the per-job
// structuredClone fixed cost into a single per-batch one.

const resultBuffer: WorkerResult[] = [];
let flushScheduled = false;

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
  // Move out of the shared buffer before postMessage in case the clone
  // triggers further microtasks that try to flush again.
  const batch: WorkerResultBatch = { type: 'results', results: resultBuffer.slice(0, n) };
  resultBuffer.length = 0;
  port.postMessage(batch);
}

function postResult(res: WorkerResult): void {
  resultBuffer.push(res);
  scheduleFlush();
}

function runJob(job: WorkerJob): void {
  // Inject proxy stubs the first time we see a (service, propertyKey) pair.
  // Proxies are static per service — re-mutating per job was wasted work.
  const proxyServices = job.proxyServices;
  if (proxyServices && proxyServices.length > 0) {
    const inst = instances.get(job.serviceName);
    if (inst) {
      for (let i = 0; i < proxyServices.length; i++) {
        const d = proxyServices[i];
        const key = job.serviceName + ':' + d.propertyKey;
        if (!proxiesInstalled.has(key)) {
          inst[d.propertyKey] = buildProxy(d) as unknown as (...args: unknown[]) => unknown;
          proxiesInstalled.add(key);
        }
      }
    }
  }

  const jobId = job.jobId;
  const inst = instances.get(job.serviceName);
  if (!inst) {
    postError(jobId, new Error(`Service "${job.serviceName}" is not registered`));
    return;
  }
  const fn = inst[job.methodName];
  if (typeof fn !== 'function') {
    postError(jobId, new Error(`Task "${job.serviceName}.${job.methodName}" is not registered`));
    return;
  }

  const abortSignalId = job.abortSignalId;
  let abortController: AbortController | undefined;
  let args = job.args;
  if (abortSignalId !== undefined) {
    abortController = new AbortController();
    pendingAborts.set(abortSignalId, abortController);
    args = [...job.args, abortController.signal];
  }

  const finish = () => {
    if (abortSignalId !== undefined) pendingAborts.delete(abortSignalId);
  };

  const exec = (): unknown => inst[job.methodName](...args);

  try {
    const alsContext = job.alsContext;
    const result = alsContext !== undefined
      ? workerAls.run(alsContext, exec)
      : exec();

    // Sync fast path: avoid Promise allocation + microtask roundtrip when
    // the task returned a plain value.
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof (result as { then?: unknown }).then !== 'function'
    ) {
      finish();
      postResult({ type: 'result', ok: true, data: result, jobId });
      return;
    }
    (result as Promise<unknown>).then(
      (data) => {
        finish();
        postResult({ type: 'result', ok: true, data, jobId });
      },
      (error: unknown) => {
        finish();
        postError(jobId, error);
      },
    );
  } catch (error: unknown) {
    finish();
    postError(jobId, error);
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
    try {
      structuredClone(err[key]);
      extra[key] = err[key];
      hasExtra = true;
    } catch { /* skip non-cloneable */
    }
  }
  return hasExtra ? extra : undefined;
}

const SKIP_ERR_KEYS = new Set(['name', 'message', 'stack', 'code']);

