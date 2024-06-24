import { deprecate } from 'node:util';
import { ITaskOption, TaskFunction } from './models';
import { createWorker } from './worker/skeleton';
import { startWorker } from './worker/executor';

/**
 * Executes the given function in a worker thread.
 * @param task - The function to be executed in the worker thread.
 * @param {ITaskOption} options - Options for the worker thread.
 * @returns The result of the task function.
 */
export const executeInThread = <T, P>(
  task: TaskFunction<T, P>,
  { threadModules = [], args = [] }: ITaskOption<P> = {},
): Promise<any> => {
  const params: P[] = [...args];
  const modules: string[] = [...threadModules];

  const workerSchema = createWorker(task, params, modules);
  return startWorker(workerSchema);
};

/**
 * Executes the given function in a worker thread by using the `ExecuteInThread` decorator.
 * @param options - Options for the worker thread.
 * @returns The result of the task function.
 */
function DeprecatedExecuteInThread<P>(
  options?: ITaskOption<P>,
): MethodDecorator {
  return function (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    // Extract options or use default values
    const { threadModules = [], args: taskArgs = [] } = options || {};

    descriptor.value = function (...args: any[]) {
      // Ensure correct context for the task function
      const task: TaskFunction<any> = originalMethod.bind(this);

      return executeInThread(task, {
        threadModules,
        args: [...taskArgs, ...args],
      });
    };

    return descriptor;
  };
}

export const ExecuteInThread = deprecate(
  DeprecatedExecuteInThread,
  'The `ExecuteInThread` decorator is deprecated. Use an alternative method.',
);
