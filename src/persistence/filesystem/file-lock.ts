import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileLockMetadata {
  readonly pid: number;
  readonly acquiredAt: string;
  readonly lockId: string;
  /** Linux process start-ticks when available, preventing PID/TID reuse from blocking recovery. */
  readonly processIdentity?: string;
}

export interface FileLockOptions {
  readonly staleAfterMs?: number;
  readonly now?: Date;
  /** A stale owner may be ignored only when this probe proves its process dead. */
  readonly staleRequiresDeadProcess?: boolean;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly processIdentity?: (pid: number) => Promise<string | null>;
  readonly processStartedAt?: (pid: number) => Promise<Date | null>;
}

interface UnavailableFileLock {
  readonly acquired: false;
  readonly release: () => Promise<void>;
}

interface CompatibilityMetadata extends FileLockMetadata {
  readonly compatibilityOwner: true;
  readonly ownerRecord: string;
}

const maximumOwnerRecords = 1024;
const compatibilityAcquiredAt = '9999-12-31T23:59:59.999Z';

export async function acquireFileLock(path: string, options?: FileLockOptions) {
  await mkdir(dirname(path), { recursive: true });
  const identity = await processIdentity(process.pid, options);
  const metadata: FileLockMetadata = {
    pid: process.pid,
    acquiredAt: (options?.now ?? new Date()).toISOString(),
    lockId: randomUUID(),
    ...(identity === null ? {} : { processIdentity: identity }),
  };
  return options?.staleRequiresDeadProcess
    ? acquireStrictFileLock(path, metadata, options)
    : acquireLegacyFileLock(path, metadata, options);
}

async function acquireStrictFileLock(
  path: string,
  metadata: FileLockMetadata,
  options: FileLockOptions,
) {
  try {
    return await acquireStrictFileLockOnce(path, metadata, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return acquireStrictFileLockOnce(path, metadata, options);
  }
}

async function acquireStrictFileLockOnce(
  path: string,
  metadata: FileLockMetadata,
  options: FileLockOptions,
) {
  const ownersPath = `${path}.owners`;
  await mkdir(ownersPath, { recursive: true });
  const legacy = await inspectLegacyOwner(path, ownersPath, options);
  if (legacy.blocks) return unavailableFileLock();
  if (legacy.reclaimableProtectedOwnerRecord !== undefined)
    await rm(join(ownersPath, legacy.reclaimableProtectedOwnerRecord), { force: true });
  const ownerName = ownerRecordName(metadata);
  const ownerPath = join(ownersPath, ownerName);
  await createOwnerRecord(ownerPath, metadata);
  try {
    const candidates = await readdir(ownersPath);
    if (candidates.length > maximumOwnerRecords) {
      await rm(ownerPath, { force: true });
      return unavailableFileLock();
    }
    if (await hasBlockingOwner(candidates, ownersPath, ownerName, legacy, options)) {
      await rm(ownerPath, { force: true });
      return unavailableFileLock();
    }
    const ownsCompatibilityPath = await createCompatibilityOwner(path, metadata, ownerName);
    if (!ownsCompatibilityPath && (await inspectLegacyOwner(path, ownersPath, options)).blocks) {
      await rm(ownerPath, { force: true });
      return unavailableFileLock();
    }
    return {
      acquired: true as const,
      metadata,
      async release() {
        let peers: readonly string[];
        try {
          peers = (await readdir(ownersPath)).filter((candidate) => candidate !== ownerName);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        if (peers.length === 0) await releaseCompatibilityOwner(path);
        await rm(ownerPath, { force: true });
        await removeEmptyOwnerDirectory(ownersPath);
      },
    };
  } catch (error) {
    await rm(ownerPath, { force: true });
    throw error;
  }
}

async function removeEmptyOwnerDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // A concurrent owner may have populated the directory.
  }
}

async function acquireLegacyFileLock(
  path: string,
  metadata: FileLockMetadata,
  options: FileLockOptions | undefined,
) {
  try {
    return await createLegacyFileLock(path, metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (options?.staleAfterMs === undefined) return unavailableFileLock();
  try {
    const prior = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata;
    if (!isStale(prior, options)) return unavailableFileLock();
  } catch {
    // Preserve the historical time-only recovery contract for malformed or vanished locks.
  }
  await rm(path, { force: true });
  try {
    return await createLegacyFileLock(path, metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return unavailableFileLock();
    throw error;
  }
}

async function createLegacyFileLock(path: string, metadata: FileLockMetadata) {
  await createOwnerRecord(path, metadata);
  return {
    acquired: true as const,
    metadata,
    release: () => releaseLegacyFileLock(path, metadata.lockId),
  };
}

async function releaseLegacyFileLock(path: string, lockId: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata;
    if (current.lockId === lockId) await rm(path, { force: true });
  } catch {
    /* already released */
  }
}

async function hasBlockingOwner(
  candidates: readonly string[],
  ownersPath: string,
  ownerName: string,
  legacy: { readonly protectedOwnerRecord?: string },
  options: FileLockOptions | undefined,
): Promise<boolean> {
  for (const candidate of candidates) {
    if (candidate === ownerName || candidate === legacy.protectedOwnerRecord) continue;
    const candidatePath = join(ownersPath, candidate);
    if (await ownerBlocksAcquisition(candidatePath, options)) return true;
    if (options?.staleRequiresDeadProcess) await rm(candidatePath, { force: true });
  }
  return false;
}

async function inspectLegacyOwner(
  path: string,
  ownersPath: string,
  options: FileLockOptions | undefined,
): Promise<{
  readonly blocks: boolean;
  readonly protectedOwnerRecord?: string;
  readonly reclaimableProtectedOwnerRecord?: string;
}> {
  let legacy: FileLockMetadata | CompatibilityMetadata;
  try {
    legacy = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata | CompatibilityMetadata;
  } catch (error) {
    return { blocks: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
  if (!('compatibilityOwner' in legacy)) {
    return { blocks: true };
  }
  const ownerPath = join(ownersPath, legacy.ownerRecord);
  const blocks = await ownerBlocksAcquisition(ownerPath, options);
  return {
    blocks,
    protectedOwnerRecord: legacy.ownerRecord,
    ...(blocks ? {} : { reclaimableProtectedOwnerRecord: legacy.ownerRecord }),
  };
}

async function createCompatibilityOwner(
  path: string,
  metadata: FileLockMetadata,
  ownerRecord: string,
): Promise<boolean> {
  try {
    await createOwnerRecord(path, {
      ...metadata,
      acquiredAt: compatibilityAcquiredAt,
      compatibilityOwner: true,
      ownerRecord,
    } as CompatibilityMetadata);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function releaseCompatibilityOwner(path: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as CompatibilityMetadata;
    if (owner.compatibilityOwner) await rm(path, { force: true });
  } catch {
    /* already released */
  }
}

async function createOwnerRecord(path: string, metadata: FileLockMetadata): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    handle = await open(path, 'wx');
  }
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ownerBlocksAcquisition(
  path: string,
  options: FileLockOptions | undefined,
): Promise<boolean> {
  let owner: FileLockMetadata;
  try {
    owner = JSON.parse(await readFile(path, 'utf8')) as FileLockMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    const encoded = /^(\d+)-(\d+)-([^.]+)\.json$/.exec(path.split(/[\\/]/).at(-1) ?? '');
    if (encoded === null) return true;
    owner = {
      pid: Number(encoded[1]),
      acquiredAt: new Date(Number(encoded[2])).toISOString(),
      lockId: encoded[3]!,
    };
  }
  if (options?.staleAfterMs === undefined || !isStale(owner, options)) return true;
  return ownerMetadataBlocks(owner, options);
}

async function ownerMetadataBlocks(
  owner: FileLockMetadata,
  options: FileLockOptions | undefined,
): Promise<boolean> {
  if (options?.staleAfterMs === undefined || !isStale(owner, options)) return true;
  if (!options.staleRequiresDeadProcess || !ownerMayBeAlive(options, owner.pid)) return false;
  const identity = await processIdentity(owner.pid, options);
  if (owner.processIdentity !== undefined)
    return identity === null || identity === owner.processIdentity;
  const startedAt = await processStartedAt(owner.pid, options);
  return (
    startedAt === null ||
    startedAt.getTime() <= Date.parse(owner.acquiredAt) + processStartToleranceMilliseconds
  );
}

function ownerRecordName(metadata: FileLockMetadata): string {
  return `${metadata.pid}-${Date.parse(metadata.acquiredAt)}-${metadata.lockId}.json`;
}

function isStale(prior: FileLockMetadata, options: FileLockOptions): boolean {
  return (
    (options.now ?? new Date()).getTime() - Date.parse(prior.acquiredAt) >= options.staleAfterMs!
  );
}

function unavailableFileLock(): UnavailableFileLock {
  return { acquired: false, async release() {} };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerMayBeAlive(options: FileLockOptions, pid: number): boolean {
  try {
    return (options.isProcessAlive ?? isProcessAlive)(pid);
  } catch {
    return true;
  }
}

const processStartToleranceMilliseconds = 1_000;

async function processIdentity(
  pid: number,
  options: FileLockOptions | undefined,
): Promise<string | null> {
  if (options?.processIdentity !== undefined) return options.processIdentity(pid);
  if (process.platform !== 'linux') return null;
  try {
    return `linux-start-ticks:${await linuxProcessStartTicks(pid)}`;
  } catch {
    return null;
  }
}

async function processStartedAt(pid: number, options: FileLockOptions): Promise<Date | null> {
  if (options.processStartedAt !== undefined) return options.processStartedAt(pid);
  if (process.platform !== 'linux') return null;
  try {
    const [targetTicks, selfTicks, procStat] = await Promise.all([
      linuxProcessStartTicks(pid),
      linuxProcessStartTicks(process.pid),
      readFile('/proc/stat', 'utf8'),
    ]);
    const bootSeconds = /^btime (\d+)$/m.exec(procStat)?.[1];
    if (bootSeconds === undefined) return null;
    const currentProcessStartedAt = Date.now() - process.uptime() * 1_000;
    const elapsedSinceBootMilliseconds = currentProcessStartedAt - Number(bootSeconds) * 1_000;
    if (elapsedSinceBootMilliseconds <= 0) return null;
    const ticksPerMillisecond = selfTicks / elapsedSinceBootMilliseconds;
    if (!Number.isFinite(ticksPerMillisecond) || ticksPerMillisecond <= 0) return null;
    return new Date(Number(bootSeconds) * 1_000 + targetTicks / ticksPerMillisecond);
  } catch {
    return null;
  }
}

async function linuxProcessStartTicks(pid: number): Promise<number> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(startTicks) || startTicks < 0)
    throw new Error('Invalid process start ticks');
  return startTicks;
}

export async function withFileLock<Value>(
  path: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const lock = await acquireFileLock(path, {
    staleAfterMs: 60_000,
    staleRequiresDeadProcess: true,
  });
  if (!lock.acquired) throw new Error(`File lock is already held: ${path}`);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
