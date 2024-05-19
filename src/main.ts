import { ITaskOption, TaskFunction } from './models';
import { createWorker } from './worker/skeleton';
import { startWorker } from './worker/executor';

/**
 * Executes the given function in a worker thread.
 * @param task - The function to be executed in the worker thread.
 * @param {ITaskOption} options - Options for the worker thread.
 * @returns The result of the task function.
 */
export const executeInThread = <T>(
  task: TaskFunction<T>,
  { threadModules = [], args = [] }: ITaskOption = {},
) => {
  const params: any[] = [...args];
  const modules: string[] = [...threadModules];

  const workerSchema = createWorker(task, params, modules);
  return startWorker(workerSchema);
};

/**
 * Executes the given function in a worker thread by using the `ExecuteInThread` decorator.
 * @param options - Options for the worker thread.
 * @returns The result of the task function.
 */
export function ExecuteInThread(options?: ITaskOption): MethodDecorator {
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

      const params: any[] = [...args, ...taskArgs];
      const modules: string[] = [...threadModules];
      // Create worker schema
      const workerSchema = createWorker(task, params, modules);
      // Start worker and return its result
      return startWorker(workerSchema);
    };

    return descriptor;
  };
}
