import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { WorkerService } from './worker.service';
import { WorkerDiscoveryService } from '../discovery/discovery.service';
import type { WorkerModuleOptions } from './worker.interfaces';

/**
 * WorkerModule – import once at the root of your application.
 *
 * @example
 *   @Module({
 *     imports: [WorkerModule.forRoot()],
 *     providers: [ConfigService, ImageService],
 *   })
 *   export class AppModule {}
 */
@Module({})
export class WorkerModule {
  static forRoot(options: WorkerModuleOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: 'WORKER_OPTIONS', useValue: options },
        WorkerDiscoveryService,
        WorkerService,
      ],
      exports: [WorkerService],
    };
  }
}
