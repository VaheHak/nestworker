import { parentPort, workerData } from 'node:worker_threads';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { WorkerContainer } from '../di/worker-container';
import type { SerializedService } from '../di/worker-container';
import type {
  WorkerJob,
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

parentPort?.postMessage({ type: 'worker:ready' });

// ── Pending IPC calls ─────────────────────────────────────────────────────
const pendingIpc = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

// ── Pending AbortControllers (keyed by abortSignalId) ────────────────────
const pendingAborts = new Map<string, AbortController>();

// ── Internal ALS for context propagation ─────────────────────────────────
// One ALS instance per context key — we use a single generic ALS that holds
// the full context map, then the user's ALS instances read from it via
// the context restoration path in WorkerService.
const workerAls = new AsyncLocalStorage<Record<string, unknown>>();

parentPort?.on('message', (msg: unknown) => {
  const message = msg as WorkerInboundMessage;

  // IPC result from main thread
  if ((message as { type?: string }).type === 'ipc:result') {
    const res = message as IpcInvokeResponse;
    const pending = pendingIpc.get(res.callId);
    if (!pending) return;
    pendingIpc.delete(res.callId);
    res.ok ? pending.resolve(res.data) : pending.reject(new Error(res.error ?? 'IPC failed'));
    return;
  }

  // Abort signal from main thread
  if ((message as { type?: string }).type === 'abort') {
    const abort = message as WorkerAbortMessage;
    pendingAborts.get(abort.abortSignalId)?.abort();
    return;
  }

  // Normal job
  queue.push(message as WorkerJob);
  runNext();
});

function buildProxy(descriptor: ProxyServiceDescriptor): ServiceInstance {
  const proxy: ServiceInstance = {};
  for (const methodName of descriptor.methodNames) {
    proxy[methodName] = (...args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const callId = crypto.randomUUID();
        pendingIpc.set(callId, { resolve, reject });
        const request: IpcInvokeRequest = {
          type: 'ipc:invoke', callId,
          propertyKey: descriptor.propertyKey,
          methodName, args,
        };
        try {
          parentPort?.postMessage(request);
        } catch (err: unknown) {
          pendingIpc.delete(callId);
          reject(new Error(
            `IPC proxy "${descriptor.propertyKey}.${methodName}" could not serialise args: ` +
            `${(err as Error).message}`
          ));
        }
      });
  }
  return proxy;
}

const queue: WorkerJob[] = [];
let busy = false;

async function runNext(): Promise<void> {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift()!;

  // Set up AbortController for this job
  const abortController = new AbortController();
  if (job.abortSignalId) {
    pendingAborts.set(job.abortSignalId, abortController);
  }

  // Inject proxy stubs
  if (job.proxyServices?.length) {
    const inst = instances.get(job.serviceName);
    if (inst) {
      for (const descriptor of job.proxyServices) {
        inst[descriptor.propertyKey] = buildProxy(descriptor) as unknown as (...args: unknown[]) => unknown;
      }
    }
  }

  // Restore ALS context and run the task inside it
  const alsContext = job.alsContext ?? {};

  const run = async () => {
    const inst = instances.get(job.serviceName);
    if (!inst) throw new Error(`Service "${job.serviceName}" is not registered`);

    const fn = inst[job.methodName];
    if (typeof fn !== 'function') {
      throw new Error(`Task "${job.serviceName}.${job.methodName}" is not registered`);
    }

    // Inject AbortSignal as a last argument if the job has an abortSignalId.
    // Call via inst.method() — not as a detached fn() — so `this` is preserved.
    const args = job.abortSignalId
      ? [...job.args, abortController.signal]
      : job.args;

    return inst[job.methodName](...args);
  };

  try {
    // Run the task inside the ALS context so any nested ALS.getStore() calls
    // inside the task body see the propagated main-thread context.
    const data = await workerAls.run(alsContext, run);
    parentPort?.postMessage({ ok: true, data });
  } catch (error: unknown) {
    const e = error as Error & { code?: string | number; [key: string]: unknown };
    const serialized: SerializedError = {
      name: e.name ?? 'Error',
      message: e.message,
      stack: e.stack,
      code: e.code,
      // Capture any extra own enumerable properties (e.g. HttpException.status)
      extra: serializeExtraProps(e),
    };
    parentPort?.postMessage({ ok: false, error: serialized });
  } finally {
    if (job.abortSignalId) {
      pendingAborts.delete(job.abortSignalId);
    }
    busy = false;
    runNext();
  }
}

function serializeExtraProps(
  err: Error & Record<string, unknown>,
): Record<string, unknown> | undefined {
  const skip = new Set(['name', 'message', 'stack', 'code']);
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const key of Object.keys(err)) {
    if (skip.has(key)) continue;
    try {
      structuredClone(err[key]);
      extra[key] = err[key];
      hasExtra = true;
    } catch { /* skip non-cloneable */ }
  }
  return hasExtra ? extra : undefined;
}
