import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule, NestFactory } from '@nestjs/core';
import { WorkerClass, WorkerTask } from '../src';
import { WorkerDiscoveryService } from '../src/discovery/discovery.service';

@Injectable()
class DepA {
  value = 42;
  get(): number {
    return this.value;
  }
}

@Injectable()
class ProxyB {
  async fetchRemote(id: number): Promise<string> {
    return `remote:${id}`;
  }
  helper() {
    return 'h';
  }
}

@Injectable()
@WorkerClass({ deps: [DepA], proxy: [ProxyB] })
class MyService {
  constructor(
    private readonly depA: DepA,
    private readonly proxyB: ProxyB,
  ) {}

  @WorkerTask({ priority: 'HIGH', timeout: 500 })
  doHigh(): number {
    return this.depA.get();
  }

  @WorkerTask({ retry: 2, retryDelay: 50 })
  doDefault(): number {
    return 1;
  }

  @WorkerTask({ retryDelay: (n: number) => n * 100 })
  withFnDelay(): number {
    return 1;
  }

  untagged(): number {
    return 0;
  }
}

@Module({
  imports: [DiscoveryModule],
  providers: [DepA, ProxyB, MyService, WorkerDiscoveryService],
})
class TestModule {}

describe('WorkerDiscoveryService', () => {
  it('discovers @WorkerTask methods with their priority/timeout/retry metadata', async () => {
    const app = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });
    try {
      const discovery = app.get(WorkerDiscoveryService);
      const tasks = discovery.scan();

      const byName = new Map(tasks.map((t) => [t.methodName, t]));
      expect(byName.size).toBe(3);

      const high = byName.get('doHigh')!;
      expect(high.serviceName).toBe('MyService');
      expect(high.priority).toBe('HIGH');
      expect(high.timeout).toBe(500);
      expect(typeof high.fn).toBe('function');

      const def = byName.get('doDefault')!;
      expect(def.priority).toBe('NORMAL');
      expect(def.retry).toBe(2);
      expect(def.retryDelay).toBe(50);

      // function retryDelay collapses to the avg of fn(1..3) = (100+200+300)/3 = 200
      const fnDelay = byName.get('withFnDelay')!;
      expect(fnDelay.retryDelay).toBe(200);

      // Proxies are surfaced with a property key and concrete method names
      expect(high.proxyInstances).toHaveLength(1);
      expect(high.proxyInstances[0].propertyKey).toBe('proxyB');
      expect(high.proxyInstances[0].methodNames).toEqual(
        expect.arrayContaining(['fetchRemote', 'helper']),
      );

      // Deps are resolved as live NestJS instances
      expect(high.deps).toHaveLength(1);
      expect(high.deps[0]).toBeInstanceOf(DepA);
    } finally {
      await app.close();
    }
  });

  it('returns the same array on a second scan() (memoised)', async () => {
    const app = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
    });
    try {
      const discovery = app.get(WorkerDiscoveryService);
      const a = discovery.scan();
      const b = discovery.scan();
      expect(a).toBe(b);
    } finally {
      await app.close();
    }
  });
});
