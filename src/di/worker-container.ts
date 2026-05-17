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
 * WHY HELPERS ARE INJECTED:
 * new Function() runs in the global scope. TypeScript compiles dynamic
 * imports using file-level helpers:
 *
 *   await import('node:os')
 *   → Promise.resolve().then(() => __importStar(require('node:os')))
 *
 * These helpers are defined as `(this && this.__importStar)` at the top of
 * each compiled file — `this` being the module. Inside new Function(),
 * `this` is the global object so all helpers resolve to undefined, causing:
 *   Fatal: Error: __importStar is not defined
 *
 * We define the helpers here (Node 16+ always has Object.create, no ternary
 * needed) and inject them alongside require as explicit parameters so both
 * `await import()` and `require()` work correctly inside task methods.
 */

export interface SerializedDep {
  name: string;
  classSource: string;
  snapshot: Record<string, unknown>;
  propertyKey: string;
}

export interface SerializedMethod {
  methodName: string;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  timeout?: number;
}

export interface SerializedService {
  name: string;
  classSource: string;
  methods: SerializedMethod[];
  deps: SerializedDep[];
}

// ── TypeScript CJS helpers ────────────────────────────────────────────────
// Node 16+ always has Object.create — no legacy ternary branch needed.

function __createBinding(
  o: Record<string, unknown>,
  m: Record<string, unknown>,
  k: string,
  k2?: string
): void {
  if (k2 === undefined) k2 = k;
  const desc = Object.getOwnPropertyDescriptor(m, k);
  if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
    Object.defineProperty(o, k2, { enumerable: true, get: () => m[k] });
  } else {
    o[k2] = m[k];
  }
}

function __setModuleDefault(
  o: Record<string, unknown>,
  v: unknown
): void {
  Object.defineProperty(o, 'default', { enumerable: true, value: v });
}

function __importStar(
  mod: Record<string, unknown>
): Record<string, unknown> {
  if (mod && mod.__esModule) return mod;
  const result: Record<string, unknown> = {};
  if (mod != null) {
    for (const k of Object.getOwnPropertyNames(mod)) {
      if (k !== 'default') __createBinding(result, mod, k);
    }
  }
  __setModuleDefault(result, mod);
  return result;
}

function __importDefault(
  mod: Record<string, unknown>
): Record<string, unknown> {
  return mod && mod.__esModule ? mod : { default: mod };
}

// ── WorkerContainer ───────────────────────────────────────────────────────

export class WorkerContainer {
  private readonly instances = new Map<string, unknown>();

  load(services: SerializedService[]): void {
    for (const svc of services) {
      const depInstances: unknown[] = [];
      for (const dep of svc.deps) {
        const inst = this.reconstructFromSource(dep.classSource, dep.name, dep.snapshot);
        this.instances.set(dep.name, inst);
        depInstances.push(inst);
      }
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
   * require + all four TypeScript CJS helpers are injected as explicit
   * parameters so that compiled dynamic imports (`await import(...)`) and
   * inline require() calls inside task methods work correctly.
   */
  private evalClass(
    classSource: string,
    className: string
  ): new (...args: unknown[]) => unknown {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'require',
      '__importStar',
      '__importDefault',
      '__createBinding',
      '__setModuleDefault',
      `return (${classSource})`
    );

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cls = factory(
      require,
      __importStar,
      __importDefault,
      __createBinding,
      __setModuleDefault
    );

    if (typeof cls !== 'function') {
      throw new Error(`WorkerContainer: eval of "${className}" did not return a constructor`);
    }
    return cls as new (...args: unknown[]) => unknown;
  }
}