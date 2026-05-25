import type { DiscoveredTask } from '../core/worker.interfaces';
import type {
  SerializedDep,
  SerializedMethod,
  SerializedService,
} from './worker-container';
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
export function serializeForWorker(
  tasks: DiscoveredTask[],
): SerializedService[] {
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
    const { metatype, instance } = representative;

    const depTypes: (new (...a: unknown[]) => unknown)[] =
      Reflect.getMetadata(WORKER_DEPS_META, metatype) ?? [];

    const serializedDeps: SerializedDep[] = depTypes.map((DepType) => {
      // Derive the property key from the class name first as a candidate,
      // then verify by looking at the live instance's own properties.
      // We read the dep instance DIRECTLY from the service instance's property
      // rather than from moduleRef.get() — this avoids the NestJS Proxy
      // mismatch where moduleRef returns the real instance but the service
      // holds a lazy Proxy wrapper (different references, same underlying object).
      const candidateKey = camelCase(DepType.name);
      const propertyKey = findDepPropertyKey(instance, DepType) ?? candidateKey;

      // Always read the dep from the live service instance by property key —
      // this gives us the exact object the service will use at runtime,
      // including any NestJS Proxy wrapper, so snapshot captures real state.
      const depInstance =
        (instance as Record<string, unknown>)[propertyKey] ??
        (instance as Record<string, unknown>)[candidateKey];

      return {
        name: DepType.name,
        filePath: findFilePath(DepType),
        snapshot: snapshotInstance(depInstance),
        propertyKey: propertyKey ?? candidateKey,
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
    if (!mod?.exports || typeof mod.exports !== 'object') continue;
    // Object.values() triggers getters on prototype-based exports (e.g. Express
    // IncomingMessage.protocol accesses this.socket which is undefined at scan
    // time). Iterate keys manually and guard each access with try/catch.
    for (const key of Object.keys(mod.exports)) {
      // Skip getters entirely — accessing them may trigger deprecation warnings
      // (e.g. Express req.host) or throw (e.g. IncomingMessage.protocol).
      // Constructors are always plain value exports, never getters.
      const desc = Object.getOwnPropertyDescriptor(mod.exports, key);
      if (!desc || typeof desc.get === 'function') continue;
      if (desc.value === ctor) return filePath;
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
  DepType: new (...args: unknown[]) => unknown,
): string | undefined {
  if (!serviceInstance || typeof serviceInstance !== 'object') return undefined;
  // private readonly fields are non-enumerable — must use getOwnPropertyNames().
  // We match by constructor type rather than reference equality to correctly
  // handle NestJS Proxy wrappers: the service may hold a Proxy of the dep
  // while moduleRef.get() returns the unwrapped instance — different refs,
  // same underlying class. instanceof sees through Proxy transparently.
  for (const key of Object.getOwnPropertyNames(serviceInstance)) {
    const val = (serviceInstance as Record<string, unknown>)[key];
    if (val instanceof DepType) return key;
  }
  return undefined;
}

function snapshotInstance(instance: unknown): Record<string, unknown> {
  if (!instance || typeof instance !== 'object') return {};
  const out: Record<string, unknown> = {};
  // private readonly fields are non-enumerable — must use getOwnPropertyNames()
  for (const k of Object.getOwnPropertyNames(instance)) {
    const v = (instance as Record<string, unknown>)[k];
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    try {
      // Store the CLONED value, not the original reference.
      // structuredClone succeeds for plain outer objects even when they
      // contain non-cloneable internal slots nested deeply — in that case
      // storing `v` would pass a live socket/stream reference into workerData,
      // producing broken objects with missing internal state in the worker.
      out[k] = structuredClone(v);
    } catch {
      /* skip non-cloneable values entirely */
    }
  }
  return out;
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
