import { DynamicModule, Module, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WorkerService } from './worker.service';
import { WorkerDiscoveryService } from '../discovery/discovery.service';
import type {
  WorkerModuleOptions,
  WorkerModuleAsyncOptions,
} from './worker.interfaces';

@Module({})
export class WorkerModule {
  /**
   * Register with static options.
   *
   * @example
   *   WorkerModule.forRoot({ poolSize: 4 })
   */
  static forRoot(options: WorkerModuleOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: 'WORKER_OPTIONS', useValue: options },
        WorkerDiscoveryService,
        WorkerService,
      ],
      exports: [WorkerService],
    };
  }

  /**
   * Register with async factory — use when options come from ConfigService
   * or other async providers.
   *
   * @example
   *   WorkerModule.forRootAsync({
   *     inject: [ConfigService],
   *     useFactory: (cfg: ConfigService) => ({
   *       poolSize: cfg.get<number>('WORKER_POOL_SIZE'),
   *       shutdownTimeout: 30_000,
   *     }),
   *   })
   */
  static forRootAsync(asyncOptions: WorkerModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: 'WORKER_OPTIONS',
      inject: (asyncOptions.inject ?? []) as never[],
      useFactory: asyncOptions.useFactory,
    };

    return {
      module: WorkerModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [optionsProvider, WorkerDiscoveryService, WorkerService],
      exports: [WorkerService],
    };
  }
}
