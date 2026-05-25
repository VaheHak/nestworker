import 'reflect-metadata';

export const WORKER_CLASS_META = 'worker:class';
export const WORKER_METHOD_META = 'worker:method';
export const WORKER_DEPS_META = 'worker:deps';
export const WORKER_PROXY_META = 'worker:proxy';

export interface WorkerTaskOptions {
  priority?: 'HIGH' | 'NORMAL' | 'LOW';
  timeout?: number;
  /** Number of additional attempts after the first failure. Default: 0. */
  retry?: number;
  /** Delay in ms between retry attempts. Supports exponential backoff
   *  when set as a function: (attempt) => attempt * 1000 */
  retryDelay?: number | ((attempt: number) => number);
}

export function WorkerClass(
  options: {
    deps?: (abstract new (...a: unknown[]) => unknown)[];
    proxy?: (abstract new (...a: unknown[]) => unknown)[];
  } = {},
): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(WORKER_CLASS_META, true, target);
    if (options.deps?.length) {
      Reflect.defineMetadata(WORKER_DEPS_META, options.deps, target);
    }
    if (options.proxy?.length) {
      Reflect.defineMetadata(WORKER_PROXY_META, options.proxy, target);
    }
  };
}

export function WorkerTask(options: WorkerTaskOptions = {}): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(WORKER_METHOD_META, options, target, propertyKey);
  };
}
