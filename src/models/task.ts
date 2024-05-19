export type TaskFunction<T> = (modules?: string[], args?: any[]) => T;

export interface ITaskOption {
  threadModules?: string[];
  args?: any[];
}
