/**
 * WorkerContainer – minimal DI container for worker threads.
 *
 * WHY NOT require(filePath)?
 * Compiled NestJS files import @nestjs/common at the top — requiring them
 * inside a worker triggers the full NestJS bootstrap chain which throws.
 *
 * THE FIX: extract each class as a plain JS string on the main thread via
 * Class.toString() (no imports, no decorators), send through workerData,
 * and eval() back into a constructor inside the worker.
 *
 * WHY require IS INJECTED:
 * new Function() runs in the global scope — CommonJS `require` is a
 * module-level variable, not a global, so it's undefined inside plain eval.
 * We pass the worker's own `require` as an explicit parameter so that
 * task methods can call require('os'), require('path'), etc. inline.
 */

export interface SerializedDep {
  name: string;
  /** Plain JS class source — eval()'d in the worker to restore prototype methods */
  classSource: string;
  /** Structured-clone snapshot of the dep's own data properties */
  snapshot: Record<string, unknown>;
  /** The exact `this.X` property key the parent service uses for this dep */
  propertyKey: string;
}

export interface SerializedMethod {
  methodName: string;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  timeout?: number;
}

export interface SerializedService {
  name: string;
  /** Plain JS class source — eval()'d in the worker to reconstruct the service */
  classSource: string;
  methods: SerializedMethod[];
  deps: SerializedDep[];
}

export class WorkerContainer {
  private readonly instances = new Map<string, unknown>();

  load(services: SerializedService[]): void {
    for (const svc of services) {
      // Step 1: reconstruct each dep from its stripped class source + snapshot
      const depInstances: unknown[] = [];
      for (const dep of svc.deps) {
        const inst = this.reconstructFromSource(dep.classSource, dep.name, dep.snapshot);
        this.instances.set(dep.name, inst);
        depInstances.push(inst);
      }

      // Step 2: instantiate service with deps injected via constructor
      const ServiceClass = this.evalClass(svc.classSource, svc.name);
      const serviceInstance = new ServiceClass(...depInstances);
      this.instances.set(svc.name, serviceInstance);
    }
  }

  get<T>(name: string): T {
    const inst = this.instances.get(name);
    if (!inst) throw new Error(`WorkerContainer: "${name}" not found`);
    return inst as T;
  }

  private reconstructFromSource(
    classSource: string,
    className: string,
    snapshot: Record<string, unknown>
  ): unknown {
    const DepClass = this.evalClass(classSource, className);
    const instance = Object.create(DepClass.prototype as object) as Record<string, unknown>;
    Object.assign(instance, snapshot);
    return instance;
  }

  /**
   * eval() a plain class declaration and return the constructor.
   *
   * `require` is injected as an explicit parameter because new Function()
   * runs in the global scope where the CommonJS `require` variable does
   * not exist. Injecting it lets task methods call require('os'),
   * require('crypto'), require('path'), etc. inline without errors.
   *
   * Only Node built-ins and pure computation packages are safe to
   * require() inside a worker — no I/O, no DB, no HTTP clients.
   */
  private evalClass(
    classSource: string,
    className: string
  ): new (...args: unknown[]) => unknown {
    // eslint-disable-next-line no-new-func
    const factory = new Function('require', `return (${classSource})`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cls = factory(require);
    if (typeof cls !== 'function') {
      throw new Error(`WorkerContainer: eval of "${className}" did not return a constructor`);
    }
    return cls as new (...args: unknown[]) => unknown;
  }
}
