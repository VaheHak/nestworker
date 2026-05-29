![](https://img.shields.io/badge/dependencies-none-brightgreen.svg)
![](https://img.shields.io/npm/dt/nestworker.svg)
![](https://img.shields.io/npm/v/nestworker.svg)
![](https://img.shields.io/npm/l/nestworker.svg)
![](https://img.shields.io/github/issues/VaheHak/nestworker.svg)
![](https://img.shields.io/github/contributors/VaheHak/nestworker.svg)
![](https://img.shields.io/github/last-commit/VaheHak/nestworker.svg)
![](https://img.shields.io/github/forks/VaheHak/nestworker.svg)
![](https://img.shields.io/github/stars/VaheHak/nestworker.svg)
![](https://img.shields.io/github/watchers/VaheHak/nestworker.svg)

<p align="center">
  <img src="icon.svg" width="120" alt="nestworker" />
</p>

# nestworker

Enterprise-grade worker thread module for NestJS. Offload CPU-bound work to a managed pool of Node.js worker threads without blocking the event loop — with decorator-driven auto-discovery, priority queuing, retry, graceful shutdown, health checks, metrics, and transparent NestJS dependency injection inside workers.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [1. Register `WorkerModule`](#1-register-workermodule)
  - [2. Decorate your service](#2-decorate-your-service)
  - [3. Call `run()`](#3-call-run)
- [API](#api)
  - [`WorkerModule.forRoot(options?)`](#workermoduleforrootoptions)
  - [`WorkerModule.forRootAsync(options)`](#workermoduleforrootasyncoptions)
  - [`@WorkerClass(options?)`](#workerclassoptions)
  - [`@WorkerTask(options?)`](#workertaskoptions)
  - [`WorkerService.run<T>(serviceName, methodName, args?, options?)`](#workerserviceruntservicename-methodname-args-options)
  - [`WorkerService` events](#workerservice-events)
  - [`WorkerService.stats()`](#workerservicestats)
- [`deps` vs `proxy`](#deps-vs-proxy)
  - [`deps` — serialise into the worker](#deps--serialise-into-the-worker)
  - [`proxy` — stay on the main thread, call via IPC](#proxy--stay-on-the-main-thread-call-via-ipc)
  - [Using both together](#using-both-together)
- [AbortController](#abortcontroller)
- [Retry and Dead Letter](#retry-and-dead-letter)
- [Graceful Shutdown](#graceful-shutdown)
- [AsyncLocalStorage Propagation](#asynclocalstorage-propagation)
- [OpenTelemetry Trace Propagation](#opentelemetry-trace-propagation)
- [Health Indicator](#health-indicator)
- [Metrics](#metrics)
- [Priority Queue](#priority-queue)
- [Per-Worker Concurrency](#per-worker-concurrency)
- [Constraints](#constraints)
  - [Arguments and return values](#arguments-and-return-values)
  - [Compiled output required](#compiled-output-required)
  - [Circular deps](#circular-deps)

---

## Features

- **Worker pool** — pre-spawned threads, warmed up before the first request
- **Zero cold start** — pool initialises on `onModuleInit`, not on the first call
- **Per-worker concurrency** — opt-in pipelining (`concurrency > 1`) keeps each worker busy across awaits and short tasks
- **Automatic message batching** — jobs and results are coalesced into a single `postMessage` per scheduling pass, amortising `structuredClone` overhead
- **Priority queue** — `HIGH / NORMAL / LOW`, binary-search sorted; no jobs are ever dropped
- **Decorator discovery** — `@WorkerClass` + `@WorkerTask` replace all manual registration
- **deps** — services serialised into the worker via `vm.runInContext()` + snapshot; use for plain config/data helpers
- **proxy** — services that stay on the main thread; the worker calls them transparently via IPC round-trip; use for DB, HTTP, queues
- **Retry + dead letter** — automatic retry with configurable delay; exhausted jobs emit a `dead` event
- **AbortController** — cancel queued or running tasks via `AbortSignal`
- **Graceful shutdown** — drains in-flight jobs before terminating workers, with a configurable deadline
- **Structured error forwarding** — errors preserve `name`, `message`, `stack`, `code`, and custom fields across the thread boundary
- **AsyncLocalStorage propagation** — ALS context (request ID, tenant, user) is snapshotted and restored inside workers
- **OpenTelemetry trace propagation** — active span context is injected into each job; no hard dependency
- **Health indicator** — plugs into `@nestjs/terminus`
- **Metrics** — counters, per-task duration percentiles (p50/p95/p99); push to any provider

---

## Requirements

| Package             | Version                                                           |
| ------------------- | ----------------------------------------------------------------- |
| Node.js             | ≥ 18 (uses the global `structuredClone`, available since Node 17) |
| `@nestjs/common`    | `^10` or `^11`                                                    |
| `@nestjs/core`      | `^10` or `^11`                                                    |
| `reflect-metadata`  | `^0.1` or `^0.2`                                                  |
| TypeScript `target` | `ES2022` or higher                                                |

> **Important:** the project must be compiled to JS before running. nestworker locates compiled files via `require.cache`, which is only populated after compilation. Running via `ts-node` directly is not supported.

`tsconfig.json` must have:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

---

## Installation

```bash
npm install nestworker
```

---

## Quick Start

### 1. Register `WorkerModule`

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { WorkerModule } from 'nestworker';

@Module({
  imports: [WorkerModule.forRoot({ poolSize: 4 })],
})
export class AppModule {}
```

Or async, when options come from `ConfigService`:

```ts
WorkerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    poolSize: cfg.get<number>('WORKER_POOL_SIZE'),
    shutdownTimeout: 30_000,
  }),
});
```

### 2. Decorate your service

```ts
// image.service.ts
import { Injectable } from '@nestjs/common';
import { WorkerClass, WorkerTask } from 'nestworker';
import { ConfigService } from './config.service';

@Injectable()
@WorkerClass({ deps: [ConfigService] })
export class ImageService {
  constructor(private readonly configService: ConfigService) {}

  @WorkerTask({ priority: 'HIGH', timeout: 10_000, retry: 2, retryDelay: 500 })
  resizeImage(value: number): number {
    const multiplier = this.configService.getNumber('MULTIPLIER');
    let total = 0;
    for (let i = 0; i < 10_000_000; i++) total += i * value * multiplier;
    return total;
  }
}
```

### 3. Call `run()`

```ts
// image.controller.ts
import { Controller, Get } from '@nestjs/common';
import { WorkerService } from 'nestworker';

@Controller('images')
export class ImageController {
  constructor(private readonly workerService: WorkerService) {}

  @Get('resize')
  resize() {
    return this.workerService.run<number>('ImageService', 'resizeImage', [5]);
  }
}
```

### Typed invocation

`run(serviceName, methodName, args)` is convenient but stringly-typed. For
compile-time safety on both the method name and its argument shape, use
`invoke(Class)` — calling any method on the returned handle delegates to
`run` and infers the right return type:

```ts
import { ImageService } from './image.service';

const out = await this.workerService.invoke(ImageService).resizeImage(5);
//    ^? number

// Per-invocation options (priority, timeout, signal, …):
await this.workerService
  .invoke(ImageService, { timeout: 5_000 })
  .generateThumbnail(320, 240);
```

---

## API

### `WorkerModule.forRoot(options?)`

| Option               | Type                      | Default            | Description                                                                                                                                                                                                                     |
| -------------------- | ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poolSize`           | `number`                  | `os.cpus().length` | Worker thread count                                                                                                                                                                                                             |
| `concurrency`        | `number`                  | `1`                | Max in-flight jobs **per worker**. Set `> 1` to pipeline jobs so workers don't sit idle between results, or while a task is awaiting I/O (proxy IPC, `fetch`, `fs`, …). Keep at `1` for purely CPU-bound, fully blocking tasks. |
| `shutdownTimeout`    | `number`                  | `30_000`           | Ms to wait for in-flight jobs on shutdown                                                                                                                                                                                       |
| `maxQueueDepth`      | `number`                  | `Infinity`         | Reject new tasks with `QueueFullError` once the pending queue exceeds this size (backpressure)                                                                                                                                  |
| `logger`             | `{ error, warn, debug? }` | NestJS `Logger`    | Plug pino / winston / etc. — anything with `error(msg, trace?)` / `warn(msg)` works                                                                                                                                             |
| `asyncLocalStorages` | `AsyncLocalStorage[]`     | `[]`               | ALS instances to propagate into workers                                                                                                                                                                                         |

> **`concurrency` ⚠ shared-state footgun.** Pipelined jobs share the same
> service instance inside a worker. If a `@WorkerTask` mutates instance
> state (counters, caches keyed without a request id, …), interleaved jobs
> will trample each other. Keep workers stateless or scope mutable state by
> jobId. Stateless transforms are safe.

> **`maxQueueDepth` + `stats().saturation`.** Read `ws.stats().saturation`
> (0–1) periodically to drive autoscaling or shed load before
> `QueueFullError` starts firing.

### `WorkerModule.forRootAsync(options)`

| Field        | Type                               | Description                        |
| ------------ | ---------------------------------- | ---------------------------------- |
| `inject`     | `any[]`                            | Tokens to inject into `useFactory` |
| `useFactory` | `(...args) => WorkerModuleOptions` | Factory — may be async             |

---

### `@WorkerClass(options?)`

Marks a NestJS provider as a container of worker tasks.

| Option  | Type     | Description                                                                                                         |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `deps`  | `Type[]` | Services to **serialise** into the worker. Must hold plain cloneable data — no DB connections, sockets, or streams. |
| `proxy` | `Type[]` | Services that **stay on the main thread**. The worker calls them via IPC. Use for anything with I/O.                |

---

### `@WorkerTask(options?)`

Marks a method to be offloaded to a worker thread.

| Option       | Type                                    | Default    | Description                                |
| ------------ | --------------------------------------- | ---------- | ------------------------------------------ |
| `priority`   | `'HIGH' \| 'NORMAL' \| 'LOW'`           | `'NORMAL'` | Queue priority                             |
| `timeout`    | `number`                                | —          | Reject after this many ms                  |
| `retry`      | `number`                                | `0`        | Extra attempts after first failure         |
| `retryDelay` | `number \| (attempt: number) => number` | `0`        | Ms between retry attempts. See note below. |

> **`retryDelay` as a function:** functions can't cross the worker boundary, so when a function is supplied it's evaluated on the main thread at discovery time as the average of `fn(1)`, `fn(2)`, `fn(3)` and a warning is logged. For precise control (including exponential backoff) pass a number and recreate the curve with the per-call `RunOptions.retryDelay` override.

---

### `WorkerService.run<T>(serviceName, methodName, args?, options?)`

| Parameter     | Type         | Description                               |
| ------------- | ------------ | ----------------------------------------- |
| `serviceName` | `string`     | Class name of the `@WorkerClass` provider |
| `methodName`  | `string`     | Method decorated with `@WorkerTask`       |
| `args`        | `unknown[]`  | structuredClone-compatible arguments      |
| `options`     | `RunOptions` | Per-call overrides (see below)            |

```ts
interface RunOptions {
  priority?: TaskPriority;
  timeout?: number;
  retry?: number;
  retryDelay?: number;
  signal?: AbortSignal; // cancel the task
}
```

---

### `WorkerService` events

```ts
workerService.onTaskStart((job) => { ... });
workerService.onTaskEnd((job, durationMs) => { ... });
workerService.onTaskError((job, error) => { ... });
workerService.onDead((event) => { ... });   // job exhausted all retries
```

---

### `WorkerService.stats()`

Returns a point-in-time snapshot of the pool — used by the health indicator and metrics service, but also useful on its own:

```ts
const { poolSize, idle, busy, queued, warmingUp } = workerService.stats();
```

```ts
interface PoolStats {
  poolSize: number;
  idle: number;
  busy: number;
  queued: number;
  warmingUp: number;
}
```

---

## `deps` vs `proxy`

This is the most important decision when declaring a `@WorkerClass`.

### `deps` — serialise into the worker

The service's compiled `.js` file is executed inside the worker via `vm.runInContext()`. Its instance properties are snapshotted via `structuredClone` and restored. The worker gets a fully independent copy — method calls are local, zero IPC overhead.

**Use when:** the service holds plain data (config values, lookup tables, constants) and its methods are pure computation over that data.

```ts
// ConfigService holds { multiplier: 3, iterations: 1_000_000 }
// — plain object, fully cloneable → safe to use as dep

@WorkerClass({ deps: [ConfigService] })
export class ImageService {
  constructor(private readonly configService: ConfigService) {}

  @WorkerTask()
  resize(value: number): number {
    // configService is a local copy inside the worker — no IPC
    return this.configService.getNumber('MULTIPLIER') * value;
  }
}
```

✅ Plain objects, arrays, primitives, `Map`, `Set`
❌ DB connections, HTTP clients, sockets, streams, open file handles

### `proxy` — stay on the main thread, call via IPC

The service is **not** sent to the worker. Instead, a lightweight stub is injected whose methods send an `ipc:invoke` message to the main thread and return a `Promise` that resolves when the main thread replies. The real NestJS service executes on the main thread with full access to DB, HTTP, and everything else.

**Use when:** the service does I/O — database queries, HTTP calls, cache reads, queue operations.

```ts
// UserService queries a database — cannot be cloned → use proxy

@WorkerClass({ proxy: [UserService] })
export class ReportService {
  constructor(private readonly userService: UserService) {}

  @WorkerTask()
  async generateReport(userId: string): Promise<string> {
    // this call transparently round-trips to the main thread
    const user = await this.userService.findById(userId);

    // heavy CPU work runs in the worker
    return crunchNumbers(user);
  }
}
```

The IPC round-trip looks like this:

```
WORKER                                    MAIN THREAD
──────────────────────────────────────    ───────────────────────────────
this.userService.findById(userId)
  │
  ├─ postMessage({ type: 'ipc:invoke',  →  onMessage handler
  │    method: 'findById', args: [...] })   │
  │                                         ├─ userService.findById(userId)
  │                                         │  (real DB query, main thread)
  │                                         │
  ◀── postMessage({ type: 'ipc:result', ─── └─ reply with result
       data: { id, name, ... } })
  │
  └─ Promise resolves with user ✓
```

> **Constraint:** proxy method arguments and return values must be `structuredClone`-compatible — they cross the thread boundary via `postMessage`. Plain objects, arrays, and primitives work. Class instances, functions, and sockets do not.

### Using both together

`deps` and `proxy` can be combined in the same `@WorkerClass`:

```ts
@WorkerClass({
  deps: [ConfigService], // cloned into worker — fast local access
  proxy: [UserService], // stays on main thread — IPC on each call
})
export class ReportService {
  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  @WorkerTask({ priority: 'LOW' })
  async buildReport(userId: string): Promise<Buffer> {
    const limit = this.configService.getNumber('REPORT_LIMIT'); // local, zero IPC
    const user = await this.userService.findById(userId); // IPC round-trip
    return heavyPdfGeneration(user, limit);
  }
}
```

---

## AbortController

Cancel a queued or running task by passing an `AbortSignal`:

```ts
const controller = new AbortController();

// Cancel after 3 seconds if not done
setTimeout(() => controller.abort(), 3000);

try {
  const result = await workerService.run('ImageService', 'resizeImage', [5], {
    signal: controller.signal,
  });
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('Task was cancelled');
  }
}
```

The `AbortSignal` is also injected as the last argument of the task method, so you can respond to cancellation inside the worker:

```ts
@WorkerTask()
processChunks(data: number[], signal: AbortSignal): number {
  let total = 0;
  for (const chunk of data) {
    if (signal.aborted) break;   // stop early on cancel
    total += heavyCompute(chunk);
  }
  return total;
}
```

---

## Retry and Dead Letter

```ts
@WorkerTask({ retry: 3, retryDelay: 1000 })
async fetchAndProcess(id: string): Promise<string> { ... }
```

After all attempts fail, a `dead` event fires:

```ts
workerService.onDead((event) => {
  console.error(`Job ${event.jobId} failed after ${event.attempts} attempts`);
  console.error(event.error.message);
  // push to external DLQ, alert, etc.
});
```

---

## Graceful Shutdown

On application shutdown, nestworker waits up to `shutdownTimeout` ms for in-flight jobs to complete before force-terminating workers. Queued jobs that haven't started are rejected immediately.

```ts
WorkerModule.forRoot({ shutdownTimeout: 30_000 });
```

---

## AsyncLocalStorage Propagation

Pass your ALS instances to `forRoot` — their current store is snapshotted at dispatch time and restored inside the worker before the task runs:

```ts
export const requestAls = new AsyncLocalStorage<{ requestId: string }>();

WorkerModule.forRoot({
  asyncLocalStorages: [requestAls],
})

// Inside a worker task:
@WorkerTask()
process(): void {
  const store = requestAls.getStore(); // { requestId: '...' } ✓
}
```

---

## OpenTelemetry Trace Propagation

If `@opentelemetry/api` is installed in your app, nestworker captures the active span context on every `run()` and re-activates it inside the worker before the task runs — distributed traces stay continuous across the thread boundary. There is **no hard dependency**: the lookup is a one-shot cached `require()` and silently no-ops when the package isn't present.

```bash
npm install @opentelemetry/api
```

```ts
// Spans created inside @WorkerTask methods will be children of the
// active span on the main thread at the moment run() was called.
@WorkerTask()
async heavyWork(): Promise<void> {
  const tracer = trace.getTracer('my-app');
  await tracer.startActiveSpan('heavy-work', async (span) => {
    // ...
    span.end();
  });
}
```

---

## Health Indicator

```ts
// health.module.ts
import { WorkerHealthIndicator } from 'nestworker';

@Module({ providers: [WorkerHealthIndicator] })
export class HealthModule {}
```

```ts
// health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { WorkerHealthIndicator } from 'nestworker';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly workerHealth: WorkerHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.workerHealth.check('workers')]);
  }
}
```

Reports `down` when workers are still warming up or queue depth exceeds pool size.

---

## Metrics

```ts
// app.module.ts
import { WorkerMetricsService } from 'nestworker';

@Module({ providers: [WorkerMetricsService] })
export class AppModule {}
```

```ts
// metrics.controller.ts
import { WorkerMetricsService } from 'nestworker';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly workerMetrics: WorkerMetricsService) {}

  @Get()
  snapshot() {
    return this.workerMetrics.snapshot();
  }
}
```

```json
{
  "jobsTotal": 1500,
  "jobsSuccess": 1480,
  "jobsFailed": 15,
  "jobsTimeout": 3,
  "jobsDead": 2,
  "queueDepth": 4,
  "idleWorkers": 2,
  "busyWorkers": 6,
  "durations": {
    "ImageService.resizeImage": {
      "p50": 42,
      "p95": 310,
      "p99": 890,
      "count": 1200
    },
    "ReportService.buildReport": {
      "p50": 180,
      "p95": 950,
      "p99": 2100,
      "count": 300
    }
  }
}
```

---

## Priority Queue

Jobs queue when all threads are busy, sorted by priority — `HIGH` always runs before `NORMAL` before `LOW`. Within the same priority, FIFO.

```ts
await Promise.all([
  workerService.run('Svc', 'task', [], { priority: 'LOW' }),
  workerService.run('Svc', 'task', [], { priority: 'HIGH' }),
  workerService.run('Svc', 'task', [], { priority: 'NORMAL' }),
  workerService.run('Svc', 'task', [], { priority: 'HIGH' }),
]);
// Execution order: HIGH → HIGH → NORMAL → LOW
```

---

## Per-Worker Concurrency

By default each worker processes one job at a time. When tasks are short, or
they `await` I/O (proxy IPC round-trips, `fetch`, `fs`, queue calls), the worker
sits idle while the main thread processes the previous result. Set
`concurrency > 1` to pipeline jobs into each worker and keep them saturated:

```ts
WorkerModule.forRoot({
  poolSize: 4, // 4 worker threads
  concurrency: 8, // up to 8 in-flight jobs per worker → 32 concurrent jobs
});
```

Guidance:

- **CPU-bound, fully blocking tasks** → keep at `1`. Extra concurrency cannot
  help when the JS thread never yields.
- **Short tasks (sub-millisecond)** → `2–4` is usually enough to hide the
  per-job postMessage cost.
- **Tasks awaiting I/O or proxy calls** → match `concurrency` to your typical
  in-flight wait depth (e.g. `8–32`).

Internally the pool also coalesces every job it dispatches in a single
scheduling pass into one `postMessage` envelope per worker, and the worker
flushes accumulated results once per microtask tick. Batching is automatic —
there is nothing to configure.

---

## Constraints

### Arguments and return values

Must be [structuredClone](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) compatible.

| ✅ Supported                          | ❌ Not supported               |
| ------------------------------------- | ------------------------------ |
| Primitives, plain objects, arrays     | Class instances with methods   |
| `Map`, `Set`, `ArrayBuffer`, `Buffer` | Functions, closures            |
| `TypedArray`, `DataView`              | `Promise`, `WeakMap`, `Socket` |

### Compiled output required

nestworker locates class files via `require.cache`. The project must be compiled to `.js` before running — `ts-node` is not supported.

### Circular deps

Circular dependencies between `@WorkerClass({ deps })` entries are not supported.

---

## Contributing

See the [contributing guide](https://github.com/VaheHak/nestworker/blob/master/CONTRIBUTING.md).

## License

Licensed under [MIT](https://github.com/VaheHak/nestworker/blob/master/LICENSE).
