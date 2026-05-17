import type { DiscoveredTask } from '../core/worker.interfaces';
import type { SerializedDep, SerializedMethod, SerializedService } from './worker-container';
import { WORKER_DEPS_META } from '../decorators/worker-task.decorator';

/**
 * serializeForWorker – converts the live NestJS service graph into a
 * structured-clone-safe SerializedService[] payload for workerData.
 *
 * KEY DESIGN DECISION: class source extraction instead of file paths.
 *
 * We cannot pass filePaths to workers because require(filePath) inside a
 * worker thread re-executes the compiled .ts output which imports @nestjs/common
 * at the top level — crashing the isolated worker context.
 *
 * Instead we extract each class's constructor and prototype methods as plain JS
 * source strings on the main thread (where NestJS is fully loaded), then send
 * those strings via workerData. WorkerContainer eval()s them in the worker —
 * no require(), no NestJS imports, no crash.
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
        classSource: extractClassSource(DepType),
        snapshot: snapshotInstance(depInstance),
        propertyKey,
      };
    });

    result.push({
      name: serviceName,
      classSource: extractClassSource(metatype),
      methods,
      deps: serializedDeps,
    });
  }

  return result;
}

/**
 * Extract a plain, self-contained class source string from a constructor.
 *
 * In TypeScript compiled output, Function.prototype.toString() on a class
 * returns the full class body including all methods — but WITHOUT the
 * import statements or decorator calls at the top of the file.
 *
 * Example output:
 *   "class ConfigService {
 *      constructor() { this.config = { MULTIPLIER: '3' }; }
 *      get(k) { return this.config[k]; }
 *      getNumber(k) { return Number(this.config[k]); }
 *    }"
 *
 * This is eval()-safe and has no NestJS dependencies.
 */
function extractClassSource(metatype: new (...args: unknown[]) => unknown): string {
  const src = metatype.toString();
  // Compiled TS classes always start with "class ClassName"
  // Strip any leading helper assignments TypeScript sometimes emits
  const classStart = src.indexOf('class ');
  if (classStart === -1) {
    throw new Error(
      `Could not extract class source for "${metatype.name}". ` +
      `Ensure the project is compiled with "target": "ES2022" or higher ` +
      `so classes are emitted as native class declarations, not functions.`
    );
  }
  return src.slice(classStart);
}

function findDepPropertyKey(
  serviceInstance: unknown,
  depInstance: unknown
): string | undefined {
  if (!serviceInstance || typeof serviceInstance !== 'object') return undefined;
  for (const [key, value] of Object.entries(
    serviceInstance as Record<string, unknown>
  )) {
    if (value === depInstance) return key;
  }
  return undefined;
}

function snapshotInstance(instance: unknown): Record<string, unknown> {
  if (!instance || typeof instance !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(instance as Record<string, unknown>)) {
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    try { structuredClone(v); out[k] = v; } catch { /* skip non-cloneable */ }
  }
  return out;
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
