import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const assignmentSecret = /((?:token|secret|password|key)=[^\s]+)/gi;
const providerCredential = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g;

export interface ProcessLogOutput {
  write(value: string): void;
}

export interface ProcessLogSink {
  write(value: string): Promise<void>;
  close(): Promise<void>;
}

export interface ProcessLogOptions {
  maxBytes?: number;
}

/** Redacts recognised secret-shaped values before process output is displayed or persisted. */
export function scrubProcessLog(value: string): string {
  return value
    .replace(assignmentSecret, (match) => `${match.slice(0, match.indexOf('=') + 1)}[REDACTED]`)
    .replace(providerCredential, '[REDACTED]');
}

/**
 * Provides a small, awaitable tee for command output. The same scrubbed bytes are
 * presented to the caller and appended to the durable target-owned log.
 */
export function createProcessLogSink(
  path: string,
  output: ProcessLogOutput,
  options: ProcessLogOptions = {},
): ProcessLogSink {
  let closed = false;

  return {
    async write(value: string): Promise<void> {
      if (closed) {
        return;
      }

      const scrubbed = scrubProcessLog(value);
      await mkdir(dirname(path), { recursive: true });
      await rotateIfRequired(path, Buffer.byteLength(scrubbed), options.maxBytes);
      await appendFile(path, scrubbed, 'utf8');
      output.write(scrubbed);
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

async function rotateIfRequired(
  path: string,
  incomingBytes: number,
  maxBytes?: number,
): Promise<void> {
  if (maxBytes === undefined) {
    return;
  }

  try {
    const current = await stat(path);
    if (current.size > 0 && current.size + incomingBytes > maxBytes) {
      await rename(path, `${path}.1`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
