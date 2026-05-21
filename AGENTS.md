# AGENTS.md — nestworker

NestJS module that runs `@WorkerTask`-decorated methods in a managed `worker_threads` pool with NestJS-style DI inside workers. Published as the `nestworker` npm package (entry `dist/index.js`).

## Architecture (read these to understand the data flow)

Main thread → worker thread pipeline:
1. `core/worker.module.ts` — `WorkerModule.forRoot(...)` / `forRootAsync(...)` registers a **global** module that imports `DiscoveryModule` and provides `WorkerService` + `WorkerDiscoveryService` + a `'WORKER_OPTIONS'` token.
2. `discovery/discovery.service.ts` — on `onModuleInit`, walks `ModulesContainer` for providers carrying `WORKER_CLASS_META`, collects methods with `WORKER_METHOD_META`, resolves `deps` and `proxy` tokens via `moduleRef.get(token, { strict: false })`, returns `DiscoveredTask[]`.
3. `di/di-serializer.ts` — `serializeForWorker(tasks)` turns each task into a `SerializedService` containing the **absolute path** to the compiled `.js` file (looked up via `require.cache`) plus a `structuredClone` snapshot of each dep's own properties. This is passed via `workerData`.
4. `core/worker.pool.ts` — spawns N `Worker` instances pointing at `dist/worker/worker-runtime.js`, maintains a binary-search-sorted priority queue (`HIGH=3, NORMAL=2, LOW=1`), waits for `worker:ready` before marking each worker idle, handles `ipc:invoke` round-trips, retries with delay, timeouts (which `terminate()` + replace the worker), and `dead` events.
5. `worker/worker-runtime.ts` — top of file: builds a `WorkerContainer`, allocates each service via `Object.create(Class.prototype)` (constructor is NEVER called), assigns deps by property key, posts `worker:ready`. Per-job: restores ALS context with `workerAls.run(...)`, injects `AbortSignal` as last arg when `abortSignalId` is set, posts `{ ok, data }` or `{ ok: false, error: SerializedError }`.
6. `di/worker-container.ts` — runs each compiled `.js` file inside a `vm.createContext` whose `require()` returns `NOOP_STUB` (a transparent Proxy) for `@nestjs/*` and `reflect-metadata` so decorator side effects no-op, while real Node modules resolve normally via `nodeModule.createRequire(filePath)`. The file's `module.exports` is cached per path.

## Critical project conventions

- **Compiled output is mandatory.** `findFilePath()` in `di-serializer.ts` scans `require.cache` for the constructor reference. `ts-node` will not populate it correctly. Always build first: `npm run build` (uses `tsconfig.build.json`).
- **`deps` vs `proxy` distinction is the central design choice** (see README "deps vs proxy"). `deps` = serialize into worker via vm + snapshot (pure data/config only — non-cloneable values are silently skipped in `snapshotInstance`). `proxy` = stays on main thread; worker auto-generates async stubs that postMessage `ipc:invoke` and await `ipc:result`. Both args and return values must be `structuredClone`-compatible.
- **Property-key matching, not constructor positional order.** `findDepPropertyKey()` uses `instanceof DepType` (sees through NestJS Proxy wrappers) to map a dep to its property on the service instance; the worker assigns by key. Do not rely on constructor parameter order surviving the boundary.
- **No `crypto.randomUUID` on hot paths.** IDs use monotonic counters (`__jobIdCounter` in `worker.service.ts`, `__callCounter` in `worker-runtime.ts`). Match this style for any new per-call IDs.
- **Frozen sentinels for empty values.** `EMPTY_PROXIES`, `EMPTY_ALS`, `EMPTY_TRACE`, `DEFAULT_TASK` are reused to avoid per-call allocation and per-call `structuredClone` of empty objects across the worker boundary. Reuse them when adding similar paths.
- **Single persistent `worker.on('message')` listener** in `worker.pool.ts` switches behavior on `warmingUp` membership. Do not add/remove per-dispatch listeners.
- **AbortSignal protocol:** caller's `AbortSignal` is non-transferable, so `WorkerService.run()` mints an `abortSignalId`, the pool tracks `signalWorkerMap`, abort sends `{ type: 'abort', abortSignalId }`, and worker-runtime's `pendingAborts` map fires a local `AbortController`. The signal is appended as the last method arg only when `abortSignalId` is set.
- **OTEL is optional.** `captureTraceContext()` does a one-shot cached `require('@opentelemetry/api')`; never add it as a hard dependency. Same pattern applies to any new optional integration.
- **`retryDelay` as a function is not supported across threads** — `discovery.service.ts` averages `fn(1..3)` and logs a warning. Document this if extending retry behavior.
- **No test framework configured.** `CONTRIBUTING.md` references `npm test` / `npm run lint` but neither script exists in `package.json`. Do not assume a test runner; if adding tests, set up the tooling and update `package.json`.
- **Style:** 2-space indent, single quotes, ES2022 target, `experimentalDecorators` + `emitDecoratorMetadata` required.

## Common workflows

- Build: `npm run build` (or `npm run build:watch`).
- Run example app: `npm run example` → runs `dist/example/main.js` (NestJS application context with `ImageService`/`ConfigService`).
- Benchmark: `npm run bench`.
- Public API surface is `src/index.ts` — re-export new public types/classes there.

## When extending the codebase

- Adding a new field that crosses the worker boundary → add it to `WorkerJob` / `WorkerResult` in `core/worker.interfaces.ts`, then handle it in both `worker.pool.ts` (`dispatch` / `handler`) and `worker/worker-runtime.ts` (`parentPort.on('message')` / `runNext`).
- Adding a new message type → extend `WorkerInboundMessage` / `WorkerOutboundMessage` discriminated unions and branch on `message.type` in both runtime and pool.
- Adding NestJS-ecosystem packages that workers might transitively import → add them to `NESTJS_STUB_PACKAGES` in `worker-container.ts` so decorator evaluation stays a no-op.

