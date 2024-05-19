import { executeInThread } from 'nestworker';

async function calculate(): Promise<void> {
  const values = await Promise.all([
    executeInThread(() => 2 ** 10),
    executeInThread(() => 3 ** 10),
  ]);

  console.log(values);
}

calculate();
