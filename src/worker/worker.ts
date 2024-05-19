import { workerData } from 'node:worker_threads';

const { workerCode } = workerData;

/**
 * Evaluates the worker code in the worker thread.
 * @param workerCode - The worker code to be evaluated in the worker thread.
 */
eval(workerCode);
