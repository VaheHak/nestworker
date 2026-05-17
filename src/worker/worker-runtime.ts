import { parentPort, workerData } from 'node:worker_threads';
import { WorkerContainer } from '../di/worker-container';
import type { SerializedService } from '../di/worker-container';

/**
 * Worker Runtime – entry point for every worker thread.
 *
 * Receives SerializedService[] via workerData and boots a WorkerContainer
 * which eval()s the stripped class sources and reconstructs the full
 * service graph (deps injected via constructor) without any require() calls
 * into NestJS-annotated files.
 *
 * Jobs are processed serially via a queue — one postMessage() reply per job,
 * which is exactly what the pool's worker.once('message') expects.
 */

const services: SerializedService[] = workerData?.services ?? [];
const container = new WorkerContainer();
container.load(services);

// Build flat dispatch map: "ServiceName.methodName" → bound callable
const tasks: Record<string, (...args: unknown[]) => unknown> = {};
for (const svc of services) {
  const inst = container.get<Record<string, (...args: unknown[]) => unknown>>(svc.name);
  for (const { methodName } of svc.methods) {
    tasks[`${svc.name}.${methodName}`] = (...args) => inst[methodName](...args);
  }
}

type Job = { serviceName: string; methodName: string; args: unknown[] };

const queue: Job[] = [];
let busy = false;

async function runNext(): Promise<void> {
  if (busy || queue.length === 0) return;
  busy = true;
  const payload = queue.shift()!;
  const key = `${payload.serviceName}.${payload.methodName}`;
  try {
    const fn = tasks[key];
    if (!fn) throw new Error(`Task "${key}" is not registered`);
    const data = await fn(...payload.args);
    parentPort?.postMessage({ ok: true, data });
  } catch (error: unknown) {
    const e = error as Error;
    parentPort?.postMessage({ ok: false, error: { message: e.message, stack: e.stack } });
  } finally {
    busy = false;
    runNext();
  }
}

parentPort?.on('message', (payload: Job) => {
  queue.push(payload);
  runNext();
});
