import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

const workerPath = path.join(__dirname, 'worker.js');

/**
 * Executes the worker code in a worker thread.
 * @param workerData - The worker data to be passed to the worker thread.
 * @returns The result of the worker thread.
 */
export function startWorker(workerData: {
  workerCode: string;
  workerParams: any[];
  workerModules: string[];
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerPath, {
      workerData,
    });

    let finished = false;

    worker.once('message', ({ errMessage, data }) => {
      finished = true;

      if (errMessage) reject(new Error(`Thread ${errMessage}`));
      else resolve(data);
    });

    worker.once('error', reject);

    worker.once('exit', () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    });
  });
}
