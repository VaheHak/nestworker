import 'reflect-metadata';

export const WORKER_CLASS_META = 'worker:class';
export const WORKER_METHOD_META = 'worker:method';
export const WORKER_DEPS_META = 'worker:deps';

export interface WorkerTaskOptions {
  priority?: 'HIGH' | 'NORMAL' | 'LOW';
  timeout?: number;
}

/**
 * @WorkerClass() – marks a provider as a container of worker tasks.
 *
 * The discovery service scans all NestJS providers for this marker,
 * then inspects each method for @WorkerTask().
 *
 * Declare any injectable deps that your @WorkerTask methods need via
 * the `deps` option. These are resolved from the live NestJS container,
 * serialised, and reconstructed inside each worker thread.
 *
 * @example
 *   @WorkerClass({ deps: [ConfigService] })
 *   export class ImageService { ... }
 */
export function WorkerClass(
  options: { deps?: (abstract new (...a: unknown[]) => unknown)[] } = {}
): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(WORKER_CLASS_META, true, target);
    if (options.deps?.length) {
      Reflect.defineMetadata(WORKER_DEPS_META, options.deps, target);
    }
  };
}

/**
 * @WorkerTask() – marks a method to be offloaded to a worker thread.
 *
 * The method must be pure with respect to thread-crossing:
 * its arguments and return value must be structured-clone compatible.
 * Any NestJS deps it needs should be declared on @WorkerClass({ deps }).
 *
 * @example
 *   @WorkerTask({ priority: 'HIGH', timeout: 5000 })
 *   resizeImage(value: number): number { ... }
 */
export function WorkerTask(options: WorkerTaskOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(WORKER_METHOD_META, options, target, propertyKey);
  };
}
