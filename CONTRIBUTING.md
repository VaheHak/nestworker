# Contributing to `nestworker`

Thanks for your interest in improving `nestworker`! Contributions of all kinds — bug fixes, features, docs, and benchmarks — are welcome.

To contribute, [fork](https://help.github.com/articles/fork-a-repo/) the repository, commit your changes on a topic branch, and [open a pull request](https://help.github.com/articles/using-pull-requests/).

## Feature Requests & Bug Reports

Please file issues in the [issue tracker](https://github.com/VaheHak/nestworker/issues). For bugs, include:

- `nestworker`, Node.js, and `@nestjs/*` versions
- A minimal reproduction (ideally based on the `src/example` app)
- Expected vs. actual behavior, plus any stack traces

For feature requests, describe the use case and how it interacts with the worker boundary (e.g. `deps` vs `proxy`, AbortSignal, retries).

## Development Setup

```bash
git clone https://github.com/VaheHak/nestworker.git
cd nestworker
npm install
npm run build
```

Common scripts (see `package.json`):

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript via `tsconfig.build.json` to `dist/`. |
| `npm run build:watch` | Same, in watch mode. |
| `npm run example` | Build and run the example NestJS app (`dist/example/main.js`). |
| `npm run bench` | Build and run the benchmark (`dist/example/bench.js`). |

> **Compiled output is mandatory.** The DI serializer locates each `@WorkerTask` provider by scanning `require.cache` for its constructor reference, which only works against the compiled `.js` files in `dist/`. Always run `npm run build` before `npm run example` / `npm run bench` or before manually verifying a change. `ts-node` is not supported.

## Tests

There is currently **no automated test suite** configured. Until one is added, please verify changes by:

1. Running `npm run build` and ensuring it completes with no errors.
2. Running `npm run example` and confirming the example app still starts and dispatches tasks correctly.
3. Running `npm run bench` for changes that may affect throughput, latency, or the dispatch hot path.

If you are adding tests, please also wire up the test runner (e.g. Vitest or Jest) and add a `test` script to `package.json` as part of the same PR.

## Linting

No ESLint configuration is checked in yet. Until one is added, please follow the existing code style manually (see below). PRs that introduce an ESLint config and a `lint` script are very welcome.

## Coding Guidelines

Follow the conventions already established in the code. In particular:

- **Indentation:** 2 spaces, no tabs.
- **Quotes:** prefer single quotes; use double quotes only to avoid escaping a single quote inside the string.
- **Language target:** TypeScript, ES2022. `experimentalDecorators` and `emitDecoratorMetadata` must remain enabled.
- **IDs on hot paths:** use monotonic counters (see `__jobIdCounter` in `core/worker.service.ts` and `__callCounter` in `worker/worker-runtime.ts`). Do not call `crypto.randomUUID()` per job/call.
- **Empty values:** reuse the frozen sentinels (`EMPTY_PROXIES`, `EMPTY_ALS`, `EMPTY_TRACE`, `DEFAULT_TASK`) instead of allocating fresh objects that must cross the worker boundary.
- **Single listener per worker:** the persistent `worker.on('message')` handler in `core/worker.pool.ts` branches on `warmingUp` membership. Do not add or remove per-dispatch listeners.
- **Optional integrations** (e.g. `@opentelemetry/api`) must be loaded via a one-shot cached `require(...)` inside a `try/catch` — never as a hard dependency.
- **NestJS-ecosystem packages** that workers might transitively import must be added to `NESTJS_STUB_PACKAGES` in `di/worker-container.ts` so decorator evaluation stays a no-op inside the worker VM.

### Crossing the worker boundary

When adding a field that needs to flow between the main thread and a worker:

1. Add it to `WorkerJob` / `WorkerResult` in `core/worker.interfaces.ts`.
2. Handle it in `core/worker.pool.ts` (`dispatch` and the message handler).
3. Handle it in `worker/worker-runtime.ts` (`parentPort.on('message')` and `runNext`).
4. Make sure all values are `structuredClone`-compatible. Functions, classes, and non-cloneable types are silently dropped by `snapshotInstance` in `di/di-serializer.ts`.

For new message types, extend the `WorkerInboundMessage` / `WorkerOutboundMessage` discriminated unions and branch on `message.type` in both the runtime and the pool.

## Public API

The package's public surface is `src/index.ts`. If you add a new public class, decorator, interface, or type, re-export it from there so it ships in `dist/index.d.ts`.

## Commit & PR Guidelines

- Keep PRs focused; split unrelated changes into separate PRs.
- Reference any related issues in the PR description (`Fixes #123`).
- Update `README.md` and/or this file when behavior, scripts, or public API change.
- For changes affecting the worker dispatch path, include before/after numbers from `npm run bench` when possible.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
