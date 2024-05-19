import { ExecuteInThread, executeInThread } from './src/main';

export class Nestworker {
  @ExecuteInThread()
  public generateWorkerCode(): Promise<number> {
    // const result = await executeInThread(() => 10 ** 10);

    return (10 ** 10) as any;
  }

  // public async generateWorkerCode() {
  //   const result = await executeInThread(() => 10 ** 10);
  //   return result;
  // }
}

const nestworker = new Nestworker();
nestworker.generateWorkerCode().then((result) => {
  console.log(result);
});
