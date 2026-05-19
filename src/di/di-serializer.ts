import type { DiscoveredTask } from '../core/worker.interfaces';
import type { SerializedDep, SerializedMethod, SerializedService } from './worker-container';
import { WORKER_DEPS_META } from '../decorators/worker-task.decorator';

/**
 * serializeForWorker – converts the live NestJS service graph into a
 * structured-clone-safe SerializedService[] payload for workerData.
 *
 * KEY DESIGN DECISION: file paths instead of class source strings.
 *
 * The previous approach extracted class source via Class.toString() and
 * eval()'d it inside the worker. This broke on any import that TS compiled
 * to a file-scoped alias (crypto_1, node_os_1, …) because those aliases
 * don't exist inside a bare new Function() scope.
 *
 * The new approach sends the absolute path to each compiled .js file.
 * WorkerContainer runs each file in a vm context with a custom require()
 * that stubs NestJS packages (so decorator calls at file-eval time are
 * silent no-ops) while letting all other imports resolve normally.
 */
export function serializeForWorker(tasks: DiscoveredTask[]): SerializedService[] {
  const byService = new Map<
    string,
    { representative: DiscoveredTask; methods: SerializedMethod[] }
  >();

  for (const task of tasks) {
    if (!byService.has(task.serviceName)) {
      byService.set(task.serviceName, { representative: task, methods: [] });
    }
    byService.get(task.serviceName)!.methods.push({
      methodName: task.methodName,
      priority: task.priority,
      timeout: task.timeout,
    });
  }

  const result: SerializedService[] = [];

  for (const [serviceName, { representative, methods }] of byService) {
    const { metatype, instance, deps } = representative;

    const depTypes: (new (...a: unknown[]) => unknown)[] =
      Reflect.getMetadata(WORKER_DEPS_META, metatype) ?? [];

    const serializedDeps: SerializedDep[] = depTypes.map((DepType, i) => {
      const depInstance = deps[i];
      const propertyKey =
        findDepPropertyKey(instance, depInstance) ?? camelCase(DepType.name);
      return {
        name: DepType.name,
        filePath: findFilePath(DepType),
        snapshot: snapshotInstance(depInstance),
        propertyKey,
      };
    });

    result.push({
      name: serviceName,
      filePath: findFilePath(metatype),
      methods,
      deps: serializedDeps,
    });
  }

  return result;
}

/**
 * Locate the compiled .js file for this constructor by scanning require.cache.
 * NestJS loads all providers via require() so every user-defined class will
 * be present in the cache at the time serializeForWorker() is called.
 */
function findFilePath(ctor: new (...args: unknown[]) => unknown): string {
  for (const [filePath, mod] of Object.entries(require.cache)) {
    if (!mod?.exports) continue;
    for (const val of Object.values(mod.exports)) {
      if (val === ctor) return filePath;
    }
  }
  throw new Error(
    `nestworker: could not find compiled file for "${ctor.name}" in require.cache. ` +
    `Ensure the class is exported from its module file and the project is ` +
    `compiled (not running via ts-node) before starting.`,
  );
}

function findDepPropertyKey(
  serviceInstance: unknown,
  depInstance: unknown,
): string | undefined {
  if (!serviceInstance || typeof serviceInstance !== 'object') return undefined;

  for (const key of Object.getOwnPropertyNames(serviceInstance)) {
    if ((serviceInstance as Record<string, unknown>)[key] === depInstance) return key;
  }
  return undefined;
}

function snapshotInstance(instance: unknown): Record<string, unknown> {
  if (!instance || typeof instance !== 'object') return {};
  const out: Record<string, unknown> = {};

  for (const k of Object.getOwnPropertyNames(instance)) {
    const v = (instance as Record<string, unknown>)[k];
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    try { structuredClone(v); out[k] = v; } catch { /* skip non-cloneable */ }
  }
  return out;
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
