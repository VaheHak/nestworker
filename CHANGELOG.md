# Changelog

All notable changes to **nestworker** will be documented in this file.

## [Unreleased]

### Added

- **`maxQueueDepth` option** + `QueueFullError` — bounded queues with explicit
  backpressure instead of unbounded growth.
- **`logger` option** — plug any `{ error, warn, debug? }` sink (pino, winston,
  bunyan, …) in place of NestJS's `Logger`.
- **`WorkerService.invoke(Class)`** — typed handle that proxies method calls
  into `run()`. Use `ws.invoke(ImageService).resize(buf)` instead of stringly
  `ws.run('ImageService', 'resize', [buf])`.
- **`PoolStats.saturation` / `PoolStats.maxQueueDepth`** — drive autoscaling
  off queue pressure.
- **`AbortSignal` forwarding into proxy methods.** When a task with a signal
  invokes a proxy, the main thread passes the same signal as the proxy's
  last argument — fetch / child_process / DB calls can honour the cancel.
- **`retryDelay` as a function is now actually attempt-aware.** Previously the
  function was pre-averaged across attempts 1–3 in `discovery.service.ts`
  before being stored; it now reaches `WorkerPool.handleFailure` intact and
  is evaluated per attempt main-thread side.

### Changed

- **Priority queue → three FIFO buckets.** `enqueue` is O(1) push and
  `dequeue` is O(1) pop from the highest non-empty bucket. Replaces the
  binary-search-+-splice sorted queue (O(n) worst case).
- **Shared `vm.Context` per worker.** `WorkerContainer` reuses a single vm
  context across all files instead of allocating one per file; cold-start on
  monorepo apps drops accordingly.
- **`AbortError` factory** is Node-16 safe (`DOMException` is optional).
- **`ALS context`** is now an indexed array (was a single-char-keyed object
  that broke past 10 storages).
- **OTel trace capture** has a `trace.getSpan(active)` fast path so the
  carrier allocation is skipped when no span is active.

### Fixed

- **AbortSignal listener leak.** Long-lived signals shared across many runs
  no longer accumulate one listener per call; the handler is removed on
  every settle path.
- **`postMessage` throw no longer hangs the task.** Non-cloneable args /
  results synthesise a `DataCloneError` job result instead of leaving the
  promise pending forever.
- **Worker error/exit handlers are idempotent.** A wedged worker emitting
  multiple `error` events before `exit` no longer double-replaces or
  double-rejects pending tasks.
- **Timeouts terminate the worker BEFORE the retry is scheduled** — a retry
  can no longer race back into a worker that's mid-termination.
- **`destroy()` race.** The drain Promise wrapper is `done`-guarded so
  duplicate settle calls can't deadlock the timeout race.
- **`require.cache` scan during serialisation is now one-shot.** Builds an
  inverted `ctor → filePath` index in O(cache + deps) instead of scanning
  the cache per dep — meaningful on large NestJS apps.
- **`AbortSignal` / `AbortController` / `Event` / `EventTarget` are now in
  the worker vm context globals** — TS metadata emit for `AbortSignal`
  parameters no longer throws `ReferenceError` at file-eval time.
- **Discovery no longer silently averages function `retryDelay`.** Backoff
  strategies like `(n) => n * 1000` now work correctly.

### Performance

- **Per-priority bucket queue** — O(1) enqueue / dequeue.
- **`proxiesInstalled`** keyed by service-instance WeakMap (no per-job
  string allocation).
- **`SerializedError.extra`** uses a single bulk `structuredClone` attempt
  with a per-key fallback only on failure.
- **One-shot `require.cache` ctor index** — O(cache + deps) cold start.

### Removed

- Dropped the `concurrency=1` back-compat path that accepted `jobId`-less
  results — every result now carries a `jobId` (the worker has emitted one
  unconditionally for several minor versions).
