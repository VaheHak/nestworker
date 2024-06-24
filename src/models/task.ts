export type TaskFunction<T, P = any> = (...args: P[]) => T;

export interface ITaskOption<P> {
  threadModules?: string[];
  args?: P[];
}
