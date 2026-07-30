import { ulid } from 'ulid';
import type { IdGenerator } from '../contracts/id-generator.js';

const VALID_PREFIX = /^[a-z][a-z0-9-]*$/;

export class UlidIdGenerator implements IdGenerator {
  next(prefix: string): string {
    if (!VALID_PREFIX.test(prefix)) throw new Error(`Invalid ID prefix: ${prefix}`);
    return `${prefix}-${ulid().toLowerCase()}`;
  }
}
