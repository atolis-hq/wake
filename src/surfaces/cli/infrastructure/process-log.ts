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

export interface ProcessOutputSource {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
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
  let acceptingWrites = true;
  let writes = Promise.resolve();

  return {
    async write(value: string): Promise<void> {
      if (!acceptingWrites) return;
      const write = writes.then(async () => {
        const scrubbed = scrubProcessLog(value);
        await mkdir(dirname(path), { recursive: true });
        await rotateIfRequired(path, Buffer.byteLength(scrubbed), options.maxBytes);
        await appendFile(path, scrubbed, 'utf8');
        output.write(scrubbed);
      });
      // Keep the durable queue live after a failed operation while preserving
      // that operation's rejection for the caller that initiated it.
      writes = write.catch(() => undefined);
      return write;
    },
    async close(): Promise<void> {
      acceptingWrites = false;
      await writes;
    },
  };
}

/**
 * Serializes detached child output into a sink and resolves only after Node's
 * `close` event confirms its stdio streams have closed. Sink failures are
 * reported rather than becoming detached, unhandled promise rejections.
 *
 * The child's full stdout+stderr always reaches the sink (durable file), but
 * only stderr is also handed to `onStderr` — the child already writes its
 * actionable failures there (GitHub request failures, tick failures) and
 * routine detail to stdout, so this lets a detached supervisor surface just
 * the actionable half on its own stderr without re-deriving severity here.
 */
export function drainProcessOutput(
  process: ProcessOutputSource,
  sink: ProcessLogSink,
  onStderr: (value: string) => void,
  reportError: (error: unknown) => void,
): Promise<void> {
  let writes = Promise.resolve();
  const report = (error: unknown) => {
    try {
      reportError(error);
    } catch {
      // A reporting failure must not make a detached child unhandled.
    }
  };
  const enqueue = (chunk: Buffer | string, escalate: boolean) => {
    const value = chunk.toString();
    writes = writes
      .then(() => sink.write(value))
      .then(() => {
        if (escalate) onStderr(scrubProcessLog(value));
      })
      .catch(report);
  };

  process.stdout?.on('data', (chunk: Buffer | string) => enqueue(chunk, false));
  process.stderr?.on('data', (chunk: Buffer | string) => enqueue(chunk, true));
  process.on('error', report);

  return new Promise((resolve) => {
    process.once('close', () => {
      void writes
        .then(() => sink.close())
        .catch(report)
        .then(resolve);
    });
  });
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
