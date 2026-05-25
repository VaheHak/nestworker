import 'reflect-metadata';
import {
  WorkerClass,
  WorkerTask,
  WORKER_CLASS_META,
  WORKER_METHOD_META,
  WORKER_DEPS_META,
  WORKER_PROXY_META,
} from '../src/decorators/worker-task.decorator';

class DepA {}
class ProxyB {}

@WorkerClass({ deps: [DepA], proxy: [ProxyB] })
class Sample {
  @WorkerTask({ priority: 'HIGH', timeout: 1234, retry: 2, retryDelay: 100 })
  high() {
    return 1;
  }

  @WorkerTask()
  defaults() {
    return 2;
  }

  notATask() {
    return 3;
  }
}

@WorkerClass()
class Empty {}

describe('@WorkerClass / @WorkerTask decorators', () => {
  it('marks the class with WORKER_CLASS_META', () => {
    expect(Reflect.getMetadata(WORKER_CLASS_META, Sample)).toBe(true);
    expect(Reflect.getMetadata(WORKER_CLASS_META, Empty)).toBe(true);
  });

  it('stores deps and proxy lists when provided', () => {
    expect(Reflect.getMetadata(WORKER_DEPS_META, Sample)).toEqual([DepA]);
    expect(Reflect.getMetadata(WORKER_PROXY_META, Sample)).toEqual([ProxyB]);
  });

  it('omits empty deps/proxy metadata to avoid stray empty arrays', () => {
    expect(Reflect.getMetadata(WORKER_DEPS_META, Empty)).toBeUndefined();
    expect(Reflect.getMetadata(WORKER_PROXY_META, Empty)).toBeUndefined();
  });

  it('records full options on each @WorkerTask method', () => {
    const high = Reflect.getMetadata(
      WORKER_METHOD_META,
      Sample.prototype,
      'high',
    );
    expect(high).toEqual({
      priority: 'HIGH',
      timeout: 1234,
      retry: 2,
      retryDelay: 100,
    });

    const defaults = Reflect.getMetadata(
      WORKER_METHOD_META,
      Sample.prototype,
      'defaults',
    );
    expect(defaults).toEqual({});
  });

  it('does not tag undecorated methods', () => {
    expect(
      Reflect.getMetadata(WORKER_METHOD_META, Sample.prototype, 'notATask'),
    ).toBeUndefined();
  });
});
