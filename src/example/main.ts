import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { WorkerModule } from '../core/worker.module';
import { WorkerService } from '../core/worker.service';
import { ConfigService } from './config.service';
import { ImageService } from './image.service';

@Module({
  imports: [
    WorkerModule.forRoot({
      poolSize: 16,
      shutdownTimeout: 10000,
      concurrency: 1,
    }),
  ],
  providers: [ConfigService, ImageService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const workerService = app.get(WorkerService);

  workerService.onTaskStart((task) => {
    console.log('Task started:', task.jobId, workerService.stats());
  });

  workerService.onTaskEnd((task, durationMs) => {
    console.log('Task ended:', task.jobId, durationMs);
  });

  workerService.onTaskError((task, error) => {
    console.log('Task error:', task.jobId, error);
  });

  workerService.onDead((task) => {
    console.log('Task dead:', task.jobId);
  });

  // ── Task 1: sequential ────────────────────────────────────────────────────
  console.log('▶ resizeImage [priority: HIGH]');
  console.time('resizeImage');
  const resized = await workerService.run<number>(
    'ImageService',
    'resizeImage',
    [5],
  );
  console.timeEnd('resizeImage');
  console.log('  result:', resized);

  // ── Task 2: sequential ────────────────────────────────────────────────────
  console.log('\n▶ generateThumbnail [priority: LOW override]');
  console.time('generateThumbnail');
  const thumb = await workerService.run<string>(
    'ImageService',
    'generateThumbnail',
    [1920, 1080],
    {
      priority: 'LOW',
      retry: 3,
      retryDelay: 1000,
    },
  );
  console.timeEnd('generateThumbnail');
  console.log('  result:', thumb);

  // ── Task 3: concurrent — proves multiple workers run in parallel ───────────
  console.log('\n▶ concurrent x4 [all 4 workers busy simultaneously]');
  console.time('concurrent');
  const results = await Promise.allSettled([
    workerService.run<number>('ImageService', 'resizeImage', [1], {
      priority: 'LOW',
    }),
    workerService.run<number>('ImageService', 'resizeImage', [2], {
      priority: 'LOW',
      timeout: 1000,
    }),
    workerService.run<string>('ImageService', 'generateThumbnail', [640, 480], {
      priority: 'HIGH',
    }),
    workerService.run<string>('ImageService', 'moduleImport'),
    workerService.run<string>('ImageService', 'moduleRequire'),
    workerService.run<string>('ImageService', 'outlineModule'),
  ]);
  console.timeEnd('concurrent');
  console.log('  results:', results);

  await app.close();
}

bootstrap().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
