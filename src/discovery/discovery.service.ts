import { Injectable } from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  WORKER_CLASS_META,
  WORKER_METHOD_META,
  WORKER_DEPS_META,
  type WorkerTaskOptions,
} from '../decorators/worker-task.decorator';
import type { DiscoveredTask } from '../core/worker.interfaces';

/**
 * WorkerDiscoveryService
 *
 * FIX: exposes scan() instead of implementing OnApplicationBootstrap.
 *
 * Both OnModuleInit and OnApplicationBootstrap fire during NestJS's own
 * bootstrap sequence — before the user's AppModule providers (ImageService
 * etc.) are guaranteed to be instantiated. The container walk finds nothing.
 *
 * scan() is called lazily by WorkerService on the first run() call.
 * By that point NestFactory.createApplicationContext() has fully resolved
 * and every provider in every module is instantiated.
 */
@Injectable()
export class WorkerDiscoveryService {
  private scanned = false;
  private discovered: DiscoveredTask[] = [];

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly moduleRef: ModuleRef,
  ) {}

  scan(): DiscoveredTask[] {
    if (this.scanned) return this.discovered;
    this.scanned = true;

    for (const module of this.modulesContainer.values()) {
      for (const wrapper of module.providers.values()) {
        this.inspectWrapper(wrapper as InstanceWrapper);
      }
    }

    return this.discovered;
  }

  private inspectWrapper(wrapper: InstanceWrapper): void {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) return;

    const isWorkerClass = Reflect.getMetadata(WORKER_CLASS_META, metatype);
    if (!isWorkerClass) return;

    const serviceName = metatype.name;
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;

    const depTypes: (abstract new (...a: unknown[]) => unknown)[] =
      Reflect.getMetadata(WORKER_DEPS_META, metatype) ?? [];

    const deps = depTypes.map((token) => {
      try {
        return this.moduleRef.get(token, { strict: false });
      } catch {
        return undefined;
      }
    });

    for (const methodName of Object.getOwnPropertyNames(proto)) {
      if (methodName === 'constructor') continue;
      const options: WorkerTaskOptions | undefined = Reflect.getMetadata(
        WORKER_METHOD_META,
        proto,
        methodName,
      );
      if (!options) continue;

      const fn = (
        instance as Record<string, (...args: unknown[]) => unknown>
      )[methodName].bind(instance);

      this.discovered.push({
        serviceName,
        methodName,
        priority: options.priority ?? 'NORMAL',
        timeout: options.timeout,
        fn,
        metatype: metatype as new (...args: unknown[]) => unknown,
        instance,
        deps,
      });
    }
  }
}
