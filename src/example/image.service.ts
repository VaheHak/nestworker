import { Injectable } from '@nestjs/common';
import { WorkerClass, WorkerTask } from '../decorators/worker-task.decorator';
import { ConfigService } from './config.service';
import fs from 'fs/promises';

@Injectable()
@WorkerClass({ deps: [ConfigService] })
export class ImageService {
  constructor(private readonly configService: ConfigService) {}

  @WorkerTask({ priority: 'HIGH' })
  resizeImage(value: number): number {
    const multiplier = this.configService.getNumber('MULTIPLIER');
    const iterations = this.configService.getNumber('ITERATIONS');
    let total = 0;
    for (let i = 0; i < iterations; i++) total += i * value * multiplier;
    return total;
  }

  @WorkerTask()
  generateThumbnail(width: number, height: number): string {
    const iterations = this.configService.getNumber('ITERATIONS');
    let hash = 0;
    for (let i = 0; i < iterations / 2; i++) hash ^= (i * width * height) | 0;
    return `thumb_${hash.toString(16)}_${width}x${height}.webp`;
  }

  @WorkerTask()
  async moduleImport(): Promise<string> {
    const os = await import('node:os');
    return `Import os size ${os.cpus().length}`;
  }

  @WorkerTask()
  async moduleRequire(): Promise<string> {
    const os = require('node:os');
    return `Require os size ${os.cpus().length}`;
  }

  /** Cheapest possible task — pure IPC overhead measurement. */
  @WorkerTask()
  noop(): number {
    return 1;
  }

  @WorkerTask()
  async outlineModule(): Promise<{ p: number; f: number }> {
    const p = await fs.readFile('./package.json', 'utf-8');
    const f = (await fetch('https://api.github.com')).status;
    return { p: p.length, f };
  }

  /**
   * Sleep `ms` then return — used by tests for timeout/abort scenarios.
   * Accepts an optional AbortSignal as the last arg (auto-injected by the
   * pool when the caller passes `{ signal }`).
   */
  @WorkerTask()
  async sleep(ms: number, signal?: AbortSignal): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      });
    });
    return `slept ${ms}ms`;
  }

  /** Always throws — used to exercise retry / dead-letter paths. */
  @WorkerTask({ retry: 0 })
  alwaysFail(): never {
    throw new Error('boom');
  }
}
