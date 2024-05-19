import { executeInThread } from 'nestworker';

// this will be executed in a dedicated thread
async function task(modules: string[]) {
  // Closure doesn't work here
  const { readFile } = modules['fs/promises'];

  const content = await readFile(__filename);

  return content.toString();
}

async function read() {
  const content = await executeInThread(task, {
    threadModules: ['fs/promises'],
  });

  console.log(content);
}

read();
