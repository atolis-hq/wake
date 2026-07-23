import { createWriteStream, type WriteStream } from 'node:fs';

import {
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_ROTATE_CHECK_INTERVAL_MS,
  rotateLogFileIfNeeded,
} from './log-rotation.js';

export type DetachedProcessLogSink = {
  write: (chunk: Buffer | string) => void;
  close: () => Promise<void>;
};

export function createDetachedProcessLogSink(
  logFile: string,
  options?: {
    maxBytes?: number;
    rotateCheckIntervalMs?: number;
    stdout?: NodeJS.WritableStream;
  },
): DetachedProcessLogSink {
  const maxBytes = options?.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const rotateCheckIntervalMs =
    options?.rotateCheckIntervalMs ?? DEFAULT_LOG_ROTATE_CHECK_INTERVAL_MS;
  const stdout = options?.stdout ?? process.stdout;

  let closed = false;
  let fileStream = openLogFile(logFile, maxBytes);

  const rotateInterval = setInterval(() => {
    if (closed) {
      return;
    }

    const stream = fileStream;
    stream.end(() => {
      if (closed) {
        return;
      }

      rotateLogFileIfNeeded(logFile, maxBytes);
      fileStream = openLogFile(logFile, maxBytes);
    });
  }, rotateCheckIntervalMs);
  rotateInterval.unref();

  return {
    write: (chunk) => {
      if (closed) {
        return;
      }

      fileStream.write(chunk);
      stdout.write(chunk);
    },
    close: () => {
      if (closed) {
        return Promise.resolve();
      }

      closed = true;
      clearInterval(rotateInterval);
      return new Promise((resolve) => {
        fileStream.end(resolve);
      });
    },
  };
}

function openLogFile(logFile: string, maxBytes: number): WriteStream {
  rotateLogFileIfNeeded(logFile, maxBytes);
  return createWriteStream(logFile, { flags: 'a' });
}
