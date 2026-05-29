/**
 * WorkerContainer – minimal DI container for worker threads.
 *
 * APPROACH: vm.runInNewContext() with a shared module cache.
 *
 * Each compiled .js file is executed inside a vm context that has:
 *   - A custom require() that blocks NestJS bootstrap imports (returning
 *     transparent Proxy stubs so decorator calls at file-eval time are no-ops)
 *   - Full access to Node built-ins and third-party packages
 *   - Correct __filename / __dirname so relative requires resolve properly
 *
 * This avoids every problem of the new Function() approach:
 *   - No alias injection (crypto_1, node_os_1, …)
 *   - No TS helper injection (__importStar, __importDefault, …)
 *   - No class-body-only extraction — the full compiled file runs as-is
 *   - Dynamic import() and require() both work natively
 */

import vm from 'node:vm';
import nodePath from 'node:path';
import nodeModule from 'node:module';
import fs from 'node:fs';

export interface SerializedDep {
  name: string;
  /** Absolute path to the compiled .js file that exports this class */
  filePath: string;
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
  /** Absolute path to the compiled .js file that exports this class */
  filePath: string;
  methods: SerializedMethod[];
  deps: SerializedDep[];
}

/**
 * NestJS packages that must never be required inside a worker.
 * Requiring them triggers the full NestJS bootstrap chain which crashes
 * in an isolated vm context. We stub them with a transparent Proxy so
 * decorator calls (@Injectable, @Controller, etc.) at file-eval time
 * become silent no-ops.
 *
 * `nestworker` itself is stubbed too: external user services typically
 * import `WorkerClass` / `WorkerTask` from `'nestworker'`, and re-loading
 * the entire framework inside every worker (just to no-op the decorators)
 * adds hundreds of ms per worker on cold start. The decorators only need
 * to do real work at main-thread discovery time; inside the worker they
 * can be transparent stubs.
 */
const NESTJS_STUB_PACKAGES = new Set([
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/microservices',
  '@nestjs/platform-express',
  '@nestjs/platform-fastify',
  'reflect-metadata',
  'nestworker',
]);

function isStubbedPackage(id: string): boolean {
  if (NESTJS_STUB_PACKAGES.has(id)) return true;
  // Also stub subpath imports like 'nestworker/decorators/...' and
  // '@nestjs/common/decorators/...'.
  if (id.startsWith('nestworker/') || id.startsWith('@nestjs/')) return true;

  // External compiled providers may inline absolute paths via
  // require(require.resolve('...')). Detect those too.
  if (nodePath.isAbsolute(id)) {
    const p = id.replace(/\\/g, '/');
    return (
      p.includes('/node_modules/@nestjs/') ||
      p.includes('/node_modules/nestworker/') ||
      p.includes('/node_modules/reflect-metadata/')
    );
  }
  return false;
}

/**
 * A Proxy that silently absorbs NestJS decorator calls at file-eval time.
 *
 * The apply trap passes through its first argument when it is a function —
 * this preserves the class through decorator factory patterns emitted by TS:
 *
 *   MyClass = Injectable()(MyClass) ?? MyClass
 *            └─ NOOP_STUB() ──┘└─ apply(MyClass) → MyClass ─┘
 *
 * Without this, NOOP_STUB would replace the class, breaking all exports.
 */
const NOOP_STUB: unknown = new Proxy(
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  function () {},
  {
    get: (_t, _k) => NOOP_STUB,
    apply: (_t, _this, args) => {
      // If called with a class/function as the first arg (decorator pattern),
      // return it unchanged so the assignment keeps the real class.
      const first = (args as unknown[])[0];
      return typeof first === 'function' ? first : NOOP_STUB;
    },
    construct: () => Object.create(null),
  },
);

// ── WorkerContainer ───────────────────────────────────────────────────────

export class WorkerContainer {
  private readonly instances = new Map<string, unknown>();

  /**
   * Module export cache — keyed by absolute file path.
   * Avoids re-executing the same file multiple times when several services
   * live in the same compiled output (monorepo barrel files, etc.).
   */
  private readonly fileCache = new Map<string, Record<string, unknown>>();

  /**
   * Shared vm.Context for ALL files loaded by this container instance.
   * Creating a fresh context per file is ~ms-scale on every cold path and
   * compounds badly with monorepo apps that load many files; one shared
   * context keeps decorator-stubbing semantics intact while collapsing the
   * cold-start cost to a single `vm.createContext` call per worker.
   *
   * Per-file bindings (`require`, `module`, `exports`, `__filename`,
   * `__dirname`) are injected just-in-time by running the file inside a
   * thin CommonJS wrapper inside this same context.
   */
  private sharedContext: vm.Context | undefined;

  load(services: SerializedService[]): void {
    for (const svc of services) {
      // Reconstruct each dep from its compiled file + snapshot
      const depsByKey = new Map<string, unknown>();
      for (const dep of svc.deps) {
        const inst = this.reconstructFromFile(dep.filePath, dep.name, dep.snapshot);
        this.instances.set(dep.name, inst);
        depsByKey.set(dep.propertyKey, inst);
      }

      // Allocate the service without calling its constructor — deps are
      // assigned by property key so constructor slot order never matters.
      //
      // NOTE on snapshot fidelity: snapshotInstance only copies own enumerable
      // values (no getters/setters). Deps that rely on prototype-defined
      // accessors will see plain-value fallbacks in the worker. Document this
      // when introducing deps with accessor-based public surface.
      const ServiceClass = this.loadClass(svc.filePath, svc.name);
      const serviceInstance = Object.create(ServiceClass.prototype as object) as Record<
        string,
        unknown
      >;

      for (const [key, inst] of depsByKey) {
        serviceInstance[key] = inst;
      }

      this.instances.set(svc.name, serviceInstance);
    }
  }

  get<T>(name: string): T {
    const inst = this.instances.get(name);
    if (!inst) throw new Error(`WorkerContainer: "${name}" not found`);
    return inst as T;
  }

  private reconstructFromFile(
    filePath: string,
    className: string,
    snapshot: Record<string, unknown>,
  ): unknown {
    const DepClass = this.loadClass(filePath, className);
    const instance = Object.create(DepClass.prototype as object) as Record<string, unknown>;
    Object.assign(instance, snapshot);
    return instance;
  }

  /**
   * Load a named export from a compiled .js file by running it in the
   * shared vm context. The context's globals include a `require` shim that
   * stubs NestJS packages so decorator calls at file-eval time are silent
   * no-ops, while all other imports resolve normally through Node's real
   * module system.
   */
  private loadClass(filePath: string, className: string): new (...args: unknown[]) => unknown {
    const exports = this.runFile(filePath);

    const cls = exports[className];
    if (typeof cls !== 'function') {
      throw new Error(
        `WorkerContainer: "${className}" not found in "${filePath}". ` +
          `Available exports: ${Object.keys(exports).join(', ')}`,
      );
    }
    return cls as new (...args: unknown[]) => unknown;
  }

  /** Lazy-init the shared context. */
  private getSharedContext(): vm.Context {
    if (this.sharedContext) return this.sharedContext;
    const context = vm.createContext({
      // Per-file bindings are injected via the CJS wrapper below; we keep
      // these on the context so files referencing `console`, `process`,
      // `Buffer`, etc. via the global resolve cheaply.
      console,
      process,
      Buffer,
      URL,
      URLSearchParams,
      fetch,
      // AbortController/AbortSignal are referenced by emitted TS metadata
      // (`__metadata("design:paramtypes", [..., AbortSignal])`) whenever a
      // @WorkerTask method declares an `AbortSignal` parameter. Missing them
      // here throws `ReferenceError: AbortSignal is not defined` at file
      // eval time, before any task can run.
      AbortController,
      AbortSignal,
      Event,
      EventTarget,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      queueMicrotask,
      Promise,
      Reflect: createReflectShim(),
      global: undefined as unknown,
    });
    (context as Record<string, unknown>).global = context;
    this.sharedContext = context;
    return context;
  }

  /**
   * Execute a compiled .js file in the shared vm context and return its
   * module.exports. Results are cached by file path.
   *
   * Files are wrapped in a CommonJS-style function so per-file bindings
   * (`require`, `module`, `exports`, `__filename`, `__dirname`) don't leak
   * into the shared context global between files.
   */
  private runFile(filePath: string): Record<string, unknown> {
    const cached = this.fileCache.get(filePath);
    if (cached) return cached;

    const source = fs.readFileSync(filePath, 'utf8');
    const mod = { exports: {} as Record<string, unknown> };
    // Insert into cache before execution so circular local requires can see a
    // partial export object instead of recursing forever.
    this.fileCache.set(filePath, mod.exports);

    const sandboxRequire = this.createSandboxRequire(filePath);
    const context = this.getSharedContext();

    // Wrap the file in a CJS-style function — same shape as Node's loader,
    // but compiled once into our shared context. This keeps per-file
    // bindings hermetic without paying for a fresh vm.createContext.
    const wrapped =
      '(function (exports, require, module, __filename, __dirname) { ' + source + '\n})';
    const fn = vm.runInContext(wrapped, context, { filename: filePath }) as (
      exports: unknown,
      require: unknown,
      module: unknown,
      __filename: string,
      __dirname: string,
    ) => void;
    fn(mod.exports, sandboxRequire, mod, filePath, nodePath.dirname(filePath));

    this.fileCache.set(filePath, mod.exports);
    return mod.exports;
  }

  private createSandboxRequire(parentFilePath: string): (id: string) => unknown {
    const parentRequire = nodeModule.createRequire(parentFilePath);

    return (id: string): unknown => {
      if (isStubbedPackage(id)) return NOOP_STUB;

      // Re-export chains like `index.js -> require('./service.js')` must stay
      // in this vm loader; otherwise nested files execute in native Node and
      // bypass our NestJS/reflect stubs.
      const resolved = this.tryResolve(parentRequire, id);
      if (resolved && shouldSandboxResolvedPath(resolved)) {
        return this.runFile(resolved);
      }

      return parentRequire(id);
    };
  }

  private tryResolve(req: NodeJS.Require, id: string): string | undefined {
    try {
      return req.resolve(id);
    } catch {
      return undefined;
    }
  }
}

function createReflectShim(): typeof Reflect {
  const shim = Object.create(Reflect) as typeof Reflect & {
    getMetadata?: (...args: unknown[]) => unknown;
    defineMetadata?: (...args: unknown[]) => unknown;
    getOwnMetadata?: (...args: unknown[]) => unknown;
    hasMetadata?: (...args: unknown[]) => boolean;
    hasOwnMetadata?: (...args: unknown[]) => boolean;
    metadata?: (...args: unknown[]) => unknown;
  };

  if (typeof shim.getMetadata !== 'function') shim.getMetadata = () => undefined;
  if (typeof shim.defineMetadata !== 'function') shim.defineMetadata = () => undefined;
  if (typeof shim.getOwnMetadata !== 'function') shim.getOwnMetadata = () => undefined;
  if (typeof shim.hasMetadata !== 'function') shim.hasMetadata = () => false;
  if (typeof shim.hasOwnMetadata !== 'function') shim.hasOwnMetadata = () => false;
  if (typeof shim.metadata !== 'function') shim.metadata = () => () => undefined;

  return shim as typeof Reflect;
}

function shouldSandboxResolvedPath(resolvedPath: string): boolean {
  if (!nodePath.isAbsolute(resolvedPath)) return false;

  const p = resolvedPath.replace(/\\/g, '/');
  const inNodeModules = p.includes('/node_modules/');
  const inNestTree =
    p.includes('/node_modules/@nestjs/') ||
    p.includes('/node_modules/nestworker/') ||
    p.includes('/node_modules/reflect-metadata/');

  if (inNodeModules && !inNestTree) return false;

  // We only execute CommonJS JS outputs in vm; leave JSON/native addons to
  // Node's normal loader.
  return p.endsWith('.js') || p.endsWith('.cjs');
}
