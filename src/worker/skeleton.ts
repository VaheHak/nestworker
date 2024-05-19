import { TaskFunction } from '../models';

/**
 * Generates a worker code snippet that executes the given function in a worker thread.
 * @param func - The function to be executed in the worker thread.
 * @returns The generated worker code as a string.
 */
const generateWorkerCode = (func: TaskFunction<any>) => `
  (async () => {
    const { parentPort, workerData } = await import('worker_threads');

    async function loadModules(moduleNames) {
      const modules = {};
      for (const moduleName of moduleNames) {
        modules[moduleName] = await import(moduleName);
      }
      return modules;
    }

    try {
      const task = ${func.toString()};
      const res = workerData.workerModules
        ? task(loadModules(workerData.workerModules), ...workerData.workerParams)
        : task(...workerData.workerParams);
      
      const data = (res instanceof Promise) ? await res : res;
      parentPort.postMessage({ data });
    } catch(err) {
      parentPort.postMessage({ errMessage: err.toString() });
    }
  })();
`;

/**
 * Creates a worker schema that contains the worker code, parameters, and modules to be loaded in the worker thread.
 * @param task - The function to be executed in the worker thread.
 * @param params - An array of parameters to be passed to the task function.
 * @param modules - An array of module names to be loaded in the worker thread.
 * @returns A worker schema object that contains the worker code, parameters, and modules to be loaded in the worker thread.
 */
export const createWorker = <T>(
  task: TaskFunction<T>,
  params: any[],
  modules: string[],
) => ({
  workerCode: generateWorkerCode(task),
  workerParams: params,
  workerModules: modules,
});
