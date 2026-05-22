# AGENTS.md — nestworker

NestJS module that runs `@WorkerTask`-decorated methods in a managed `worker_threads` pool with NestJS-style DI inside workers. Published as the `nestworker` npm package (entry `dist/index.js`).

## Architecture (read these to understand the data flow)

Main thread → worker thread pipeline:
1. `core/worker.module.ts` — `WorkerModule.forRoot(...)` / `forRootAsync(...)` registers a **global** module that imports `DiscoveryModule` and provides `WorkerService` + `WorkerDiscoveryService` + a `'WORKER_OPTIONS'` token. Options include `poolSize`, `concurrency` (per-worker in-flight cap, default 1), `shutdownTimeout`, `asyncLocalStorages`.
2. `discovery/discovery.service.ts` — on `onModuleInit`, walks `ModulesContainer` for providers carrying `WORKER_CLASS_META`, collects methods with `WORKER_METHOD_META`, resolves `deps` and `proxy` tokens via `moduleRef.get(token, { strict: false })`, returns `DiscoveredTask[]`.
3. `di/di-serializer.ts` — `serializeForWorker(tasks)` turns each task into a `SerializedService` containing the **absolute path** to the compiled `.js` file (looked up via `require.cache`) plus a `structuredClone` snapshot of each dep's own properties. This is passed via `workerData`.
4. `core/worker.pool.ts` — spawns N `Worker` instances pointing at `dist/worker/worker-runtime.js`. Maintains a binary-search-sorted priority queue (`HIGH=3, NORMAL=2, LOW=1`) with a head-index FIFO (`queueHead`, lazy compaction at >1024) so `shift()` is O(1). Each worker is pushed into `idle: Worker[]` **`concurrency` times** when `worker:ready` arrives, then popped/pushed per dispatch/completion to pipeline jobs. Handles `ipc:invoke` round-trips, retries with delay, timeouts (which `terminate()` + replace the worker), and `dead` events. Per-worker state (`active: Map<jobId, ActiveSlot>`) is attached via a `STATE` symbol slot to avoid Map lookups on the hot path.
5. `worker/worker-runtime.ts` — top of file: builds a `WorkerContainer`, allocates each service via `Object.create(Class.prototype)` (constructor is NEVER called), assigns deps by property key, posts `worker:ready`. Per-job: restores ALS context with `workerAls.run(...)`, injects `AbortSignal` as last arg when `abortSignalId` is set, posts `{ ok, data, jobId }` or `{ ok: false, error: SerializedError, jobId }` via `postResult` (which buffers + microtask-flushes — see "Batching" below). Sync-returning tasks take a fast path that skips Promise allocation.
6. `di/worker-container.ts` — runs each compiled `.js` file inside a `vm.createContext` whose `require()` returns `NOOP_STUB` (a transparent Proxy) for `@nestjs/*` and `reflect-metadata` so decorator side effects no-op, while real Node modules resolve normally via `nodeModule.createRequire(filePath)`. The file's `module.exports` is cached per path.

### Batching (job & result coalescing)

To amortise the fixed per-`postMessage` `structuredClone` setup cost:

- **Main → worker:** `schedule()` is deferred via `queueMicrotask(drain)` and guarded by `scheduleQueued`, so a synchronous burst of `run()` calls accumulates into a single drain pass. The `drain` loop pops idle slots, groups jobs by target worker into a `batches: Map<Worker, WorkerJob[]>`, and ships each group as a `WorkerJobBatch` (`{ type: 'batch', jobs }`) — or as a bare `WorkerJob` if the group has length 1.
- **Worker → main:** `postResult` pushes into `resultBuffer` and schedules a single `flushResults` microtask. Multiple jobs whose promises settle in the same microtask drain ship as one `WorkerResultBatch` (`{ type: 'results', results }`); a length-1 buffer flushes as a bare `WorkerResult`.
- **Result routing:** results carry `jobId` so the pool can route each one to its `ActiveSlot` via `state.active.get(jobId)`. When `concurrency === 1` the pool also accepts a `jobId`-less result for back-compat (single-element `active` map).

When adding new outbound message paths, **reuse `postResult`** if the message represents a job result so it gets batched automatically. Per-message dispatches (e.g. `ipc:invoke`, `worker:ready`) bypass the buffer intentionally.

## Critical project conventions

- **Compiled output is mandatory.** `findFilePath()` in `di-serializer.ts` scans `require.cache` for the constructor reference. `ts-node` will not populate it correctly. Always build first: `npm run build` (uses `tsconfig.build.json`).
- **`deps` vs `proxy` distinction is the central design choice** (see README "deps vs proxy"). `deps` = serialize into worker via vm + snapshot (pure data/config only — non-cloneable values are silently skipped in `snapshotInstance`). `proxy` = stays on main thread; worker auto-generates async stubs that postMessage `ipc:invoke` and await `ipc:result`. Both args and return values must be `structuredClone`-compatible.
- **Property-key matching, not constructor positional order.** `findDepPropertyKey()` uses `instanceof DepType` (sees through NestJS Proxy wrappers) to map a dep to its property on the service instance; the worker assigns by key. Do not rely on constructor parameter order surviving the boundary.
- **No `crypto.randomUUID` on hot paths.** IDs use monotonic counters (`__jobIdCounter` in `worker.service.ts`, `__callCounter` in `worker-runtime.ts`). Match this style for any new per-call IDs.
- **Frozen sentinels for empty values.** `EMPTY_PROXIES`, `EMPTY_ALS`, `EMPTY_TRACE`, `DEFAULT_TASK` are reused to avoid per-call allocation and per-call `structuredClone` of empty objects across the worker boundary. Reuse them when adding similar paths.
- **Keep `WorkerJob` minimal.** Only fields the worker actually reads (`jobId`, `serviceName`, `methodName`, `args`, `proxyServices?`, `alsContext?`, `traceContext?`, `abortSignalId?`) cross the wire. Main-thread-only policy (`priority`, `timeout`, `retry`, `retryDelay`, `attempts`) lives on `PendingTask` in `worker.pool.ts` and must NOT be added to `WorkerJob` — that defeats the structuredClone-payload minimisation on the hot path.
- **Single persistent `worker.on('message')` listener** in `worker.pool.ts` switches behavior on `warmingUp` membership and on `message.type` (`worker:ready` / `ipc:invoke` / `results` batch / single `WorkerResult`). Do not add/remove per-dispatch listeners.
- **Per-worker state via `STATE` symbol slot.** Access through `getState(worker)` — never via `WeakMap`. The `active: Map<jobId, ActiveSlot>` is the source of truth for in-flight jobs; both timeouts and worker-error/exit handlers must drain it and decrement `activeCount`.
- **Idle pool holds `concurrency` slots per worker.** `replaceWorker()` therefore removes **all** occurrences of the dead worker from `idle` (not just the first one). Match this when adding any other pool that tracks workers.
- **Proxy stubs are installed once per `(serviceName, propertyKey)`**, guarded by `proxiesInstalled` in `worker-runtime.ts` and cached in `proxyCache`. Do not re-install per job.
- **Sync fast paths matter.** Both `runJob` (task return) and `handleIpcInvoke` (proxy reply) check `typeof result.then !== 'function'` before going through Promise.resolve; preserve this shape in any new dispatch sites.
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

- Adding a new field that crosses the worker boundary → first decide if it's per-job runtime data (then add it to `WorkerJob` / `WorkerResult` in `core/worker.interfaces.ts` and handle it in both `worker.pool.ts` `prepareDispatch`/`completeJob` and `worker/worker-runtime.ts` `runJob`/`postResult`) or main-thread-only policy (then add it to `PendingTask` in `worker.pool.ts` and keep it off the wire).
- Adding a new message type → extend `WorkerInboundMessage` / `WorkerOutboundMessage` discriminated unions, branch on `message.type` in both `worker-runtime.ts`'s `port.on('message')` and `worker.pool.ts`'s `onMessage`, and remember to handle the **batched** form too if the message is a job result (use `postResult` so it joins the existing flush loop).
- Adding NestJS-ecosystem packages that workers might transitively import → add them to `NESTJS_STUB_PACKAGES` in `worker-container.ts` so decorator evaluation stays a no-op.
- Adding a new per-worker resource → attach it to the `WorkerState` returned by `getState(worker)` rather than allocating a parallel `WeakMap`, and clean it up in `handleWorkerError` / `handleWorkerExit` / `replaceWorker`.

