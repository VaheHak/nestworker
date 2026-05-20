import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef, ModulesContainer } from '@nestjs/core';
import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  WORKER_CLASS_META,
  WORKER_METHOD_META,
  WORKER_DEPS_META,
  WORKER_PROXY_META,
  type WorkerTaskOptions,
} from '../decorators/worker-task.decorator';
import type { DiscoveredTask, ProxyInstance } from '../core/worker.interfaces';

@Injectable()
export class WorkerDiscoveryService {
  private readonly logger = new Logger(WorkerDiscoveryService.name);
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
      for (const wrapper of module.controllers.values()) {
        this.inspectWrapper(wrapper as InstanceWrapper);
      }
    }

    if (this.discovered.length === 0) {
      this.logger.warn(
        'No @WorkerTask methods found. Ensure at least one class is decorated ' +
        'with @WorkerClass() and has methods decorated with @WorkerTask().',
      );
    }

    return this.discovered;
  }

  private inspectWrapper(wrapper: InstanceWrapper): void {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) return;
    if (!Reflect.getMetadata(WORKER_CLASS_META, metatype)) return;

    const serviceName = metatype.name;
    const proto = metatype.prototype as Record<string, unknown>;

    // ── serialised deps ───────────────────────────────────────────────────
    const depTypes: (abstract new (...a: unknown[]) => unknown)[] =
      Reflect.getMetadata(WORKER_DEPS_META, metatype) ?? [];

    const deps = depTypes.map((token) =>
      this.resolveToken(token, serviceName, 'deps')
    );

    // ── proxy services ────────────────────────────────────────────────────
    const proxyTypes: (abstract new (...a: unknown[]) => unknown)[] =
      Reflect.getMetadata(WORKER_PROXY_META, metatype) ?? [];

    const proxyInstances: ProxyInstance[] = proxyTypes.map((token) => {
      const svcInstance = this.resolveToken(token, serviceName, 'proxy') as
        Record<string, (...args: unknown[]) => unknown> | undefined;

      const tokenName = (token as { name?: string }).name ?? 'unknown';
      const propertyKey = findPropertyKey(instance, svcInstance) ?? camelCase(tokenName);

      if (!findPropertyKey(instance, svcInstance)) {
        this.logger.warn(
          `${serviceName}: could not find property key for proxy "${tokenName}" ` +
          `— falling back to camelCase: "${propertyKey}".`,
        );
      }

      const methodNames: string[] = [];
      if (svcInstance) {
        let cursor = Object.getPrototypeOf(svcInstance) as object | null;
        while (cursor && cursor !== Object.prototype) {
          for (const k of Object.getOwnPropertyNames(cursor)) {
            if (k !== 'constructor' && !methodNames.includes(k)) {
              const desc = Object.getOwnPropertyDescriptor(cursor, k);
              if (desc && typeof desc.value === 'function') methodNames.push(k);
            }
          }
          cursor = Object.getPrototypeOf(cursor) as object | null;
        }
      }

      return { propertyKey, methodNames, instance: svcInstance ?? {} };
    });

    // ── @WorkerTask methods ───────────────────────────────────────────────
    let tasksFound = 0;

    for (const methodName of Object.getOwnPropertyNames(proto)) {
      if (methodName === 'constructor') continue;

      const options: WorkerTaskOptions | undefined = Reflect.getMetadata(
        WORKER_METHOD_META, proto, methodName,
      );
      if (!options) continue;

      tasksFound++;

      // Normalise retryDelay: function form → serialised as max of first 3 calls
      // (functions can't cross the thread boundary; we store the numeric value)
      let retryDelay: number | undefined;
      if (typeof options.retryDelay === 'function') {
        // Store delays for attempts 1-3 as a simple average to give workers
        // a representative delay. For production use, pass a number.
        const fn = options.retryDelay;
        retryDelay = Math.round((fn(1) + fn(2) + fn(3)) / 3);
        this.logger.warn(
          `${serviceName}.${methodName}: retryDelay as a function is not supported ` +
          `across thread boundaries. Computed average: ${retryDelay}ms. ` +
          `Pass a number for precise control.`,
        );
      } else {
        retryDelay = options.retryDelay;
      }

      const fn = (
        instance as Record<string, (...args: unknown[]) => unknown>
      )[methodName].bind(instance);

      this.discovered.push({
        serviceName,
        methodName,
        priority: options.priority ?? 'NORMAL',
        timeout: options.timeout,
        retry: options.retry,
        retryDelay,
        fn,
        metatype: metatype as new (...args: unknown[]) => unknown,
        instance,
        deps,
        proxyInstances,
      });

      this.logger.debug(
        `Registered task: ${serviceName}.${methodName} ` +
        `[priority=${options.priority ?? 'NORMAL'}` +
        `${options.timeout ? `, timeout=${options.timeout}ms` : ''}` +
        `${options.retry ? `, retry=${options.retry}` : ''}]`,
      );
    }

    if (tasksFound === 0) {
      this.logger.warn(`${serviceName} has @WorkerClass() but no @WorkerTask() methods.`);
    }
  }

  private resolveToken(
    token: abstract new (...a: unknown[]) => unknown,
    ownerName: string,
    role: 'deps' | 'proxy',
  ): unknown {
    try {
      return this.moduleRef.get(token, { strict: false });
    } catch (err: unknown) {
      const name = (token as { name?: string }).name ?? String(token);
      this.logger.error(
        `${ownerName}: failed to resolve ${role} token "${name}". ` +
        `Original error: ${(err as Error).message}`,
      );
      return undefined;
    }
  }
}

function findPropertyKey(
  serviceInstance: unknown,
  depInstance: unknown,
): string | undefined {
  if (!serviceInstance || !depInstance || typeof serviceInstance !== 'object') return undefined;
  for (const key of Object.getOwnPropertyNames(serviceInstance)) {
    if ((serviceInstance as Record<string, unknown>)[key] === depInstance) return key;
  }
  return undefined;
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}
