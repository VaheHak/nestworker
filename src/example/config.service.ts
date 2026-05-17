import { Injectable } from '@nestjs/common';

/**
 * ConfigService – a plain injectable dep declared on @WorkerClass.
 *
 * Its internal `config` map is a plain Record, so it survives
 * structured-clone intact. WorkerContainer reconstructs it via
 * Object.create(prototype) + Object.assign(snapshot), restoring
 * both the get() / getNumber() methods and the runtime config values.
 */
@Injectable()
export class ConfigService {
  private readonly config: Record<string, string> = {
    MULTIPLIER: '3',
    ITERATIONS: '10000000',
  };

  get(key: string): string {
    return this.config[key] ?? '';
  }

  getNumber(key: string): number {
    return Number(this.config[key] ?? 0);
  }
}
