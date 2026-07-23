import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LOG_MAX_BYTES,
  rotateLogFileIfNeeded,
  resolveLogMaxBytes,
  resolveLogRotateCheckIntervalMs,
} from '../../src/lib/log-rotation.js';

describe('log rotation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempLog(contents: string): string {
    const dir = join(tmpdir(), `wake-log-rotation-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    const logFile = join(dir, 'start.log');
    writeFileSync(logFile, contents);
    return logFile;
  }

  it('does not rotate when the log file is below the size threshold', () => {
    const logFile = createTempLog('small log');

    expect(rotateLogFileIfNeeded(logFile, 1024)).toBe(false);
    expect(rotateLogFileIfNeeded(logFile, 1024)).toBe(false);
  });

  it('rotates oversized logs to a single backup file', () => {
    const logFile = createTempLog('x'.repeat(32));
    const backupFile = `${logFile}.1`;

    expect(rotateLogFileIfNeeded(logFile, 16)).toBe(true);
    expect(rotateLogFileIfNeeded(logFile, 16)).toBe(false);

    expect(existsSync(logFile)).toBe(false);
    expect(readFileSync(backupFile, 'utf-8')).toBe('x'.repeat(32));
  });

  it('replaces an existing backup file on rotation', () => {
    const logFile = createTempLog('new-content');
    const backupFile = `${logFile}.1`;
    writeFileSync(backupFile, 'old-backup');

    expect(rotateLogFileIfNeeded(logFile, 4)).toBe(true);

    expect(readFileSync(backupFile, 'utf-8')).toBe('new-content');
  });

  it('resolves max bytes from env with a safe default', () => {
    expect(resolveLogMaxBytes({})).toBe(DEFAULT_LOG_MAX_BYTES);
    expect(resolveLogMaxBytes({ WAKE_LOG_MAX_BYTES: '4096' })).toBe(4096);
    expect(resolveLogMaxBytes({ WAKE_LOG_MAX_BYTES: 'not-a-number' })).toBe(DEFAULT_LOG_MAX_BYTES);
  });

  it('resolves rotate check interval from env with a safe default', () => {
    expect(resolveLogRotateCheckIntervalMs({})).toBe(5 * 60 * 1000);
    expect(resolveLogRotateCheckIntervalMs({ WAKE_LOG_ROTATE_CHECK_INTERVAL_MS: '1000' })).toBe(
      1000,
    );
    expect(resolveLogRotateCheckIntervalMs({ WAKE_LOG_ROTATE_CHECK_INTERVAL_MS: 'bad' })).toBe(
      5 * 60 * 1000,
    );
  });
});
