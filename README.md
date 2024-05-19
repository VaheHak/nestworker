![](https://img.shields.io/badge/dependencies-none-brightgreen.svg)
![](https://img.shields.io/npm/dt/nestworker.svg)
![](https://img.shields.io/npm/l/nestworker.svg)

# nestworker
A simple library that provides an abstraction for the Node.js `worker_threads` module. You can run your function in a dedicated thread by working with Promises.

### Example
```ts
import { executeInThread } from 'nestworker';

async function calculate(): Promise<void> {
  const values = await Promise.all([
    executeInThread(() => 2 ** 10),
    executeInThread(() => 3 ** 10),
  ]);

  console.log(values);
}

calculate();
```

This example demonstrates the optimization of two resource-intensive calculations through parallel execution in distinct threads.
By distributing the tasks across separate threads, significant time savings are achieved.

Nestworker's takes a task function as its parameter, orchestrates its execution in a new thread, and subsequently delivers a Promise.

**Surprisingly simple, isn't it?**

## Installation

```shell
$ npm i nestworker
```

## All examples:
- [Basic example](https://github.com/VaheHak/nestworker/tree/master/examples/basic.ts)
- [Parameters for the thread task](https://github.com/VaheHak/nestworker/blob/master/examples/multi-params.ts)
- [Async function inside the thread](https://github.com/VaheHak/nestworker/blob/master/examples/async-task.ts)
- [Error handling](https://github.com/VaheHak/nestworker/blob/master/examples/error-handling.ts)
- [Use modules inside the thread](https://github.com/VaheHak/nestworker/blob/master/examples/modules-in-thread.ts)

## Contributing

See the [contributing guide](https://github.com/VaheHak/nestworker/blob/master/CONTRIBUTING.md) for detailed instructions on how to get started with our project.

## API

### `executeInThread(task, { args: any[] }
Runs the specified function in a separate thread.

#### Parameters
- `Task (Function)`: The function to be executed in a thread.
    - This can also be a async function (promise).
- `...params (Any)`: Additional arguments to be passed to the Task function.
    - Parameter cann't be a function.

```ts
const task = function([a, b, c]) { ... };
executeInThread(task, { args: [1, {}, true] })
```

The `executeInThread` function allows you to execute a given task function in a dedicated thread, similar to the behavior of `setTimeout` or `setInterval`. You provide the main function to be executed, along with any additional arguments (...args) that should be passed to the given function.

#### Returns
`Promise<any>`: A Promise that resolves with the return value of the callback.

Inside the provided function, you have the flexibility to return any value, including a Promise. The returned value, whether it's a standard value or a Promise, will be passed back to you as the resolved result of the `Promise` returned by the `executeInThread` function.

```ts
const number = await executeInThread(() => 123); // 123
const name = await executeInThread(() => Promise.resolve('John')); // John
```

#### Important (limitation)

Access to data outside of the task function is restricted. If you require the use of a module, it should be required within the task function. The sole method for accessing data within a task function from external sources is through the utilization of the parameters. Closures do not function in this context.

In this example, we're reading a file in a separate thread and returning the data in string format. We start by defining a task function that will run within the thread, and then we prepare the necessary parameters to be passed as inputs to that function.

```ts
import { executeInThread } from 'nestworker';

async function task(fileName) {
// Closure doesn't work here
  const { readFile } = await import('fs/promises');
  const content = await readFile(__filename);
  return content.toString();
}

async function read() {
  const content = await executeInThread(task, fileName);
  console.log(content);
}

read();
```

There is also another option if you don't want to use `import` inside the function.

```ts
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
```

The `ThreadModules` class lets you set up modules for the thread. You can provide it only thorough the second argument, and you'll have access to the libraries through the `modules` object.

You should only provide the `ThreadModules` type of object once through the second parameter. Attempting to provide it multiple times will result in an error. Additionally, avoid returning the `modules` object from the task function, as it will also lead to errors.