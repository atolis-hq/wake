import { readFileSync } from 'node:fs';

export interface ProcessIdentity {
  pid: number;
  processStartedAt: string;
}

const currentProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

function readLinuxProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endCommand = stat.lastIndexOf(')');
    if (endCommand === -1) {
      return undefined;
    }
    const fields = stat
      .slice(endCommand + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19];
    return startTicks === undefined ? undefined : `linux-start-ticks:${startTicks}`;
  } catch {
    return undefined;
  }
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return null;
    }
  }

  const linuxStartedAt = readLinuxProcessStartTicks(pid);
  if (linuxStartedAt !== undefined) {
    return { pid, processStartedAt: linuxStartedAt };
  }

  if (pid === process.pid) {
    return { pid, processStartedAt: currentProcessStartedAt };
  }

  return null;
}

export function currentProcessIdentity(): ProcessIdentity {
  return (
    readProcessIdentity(process.pid) ?? {
      pid: process.pid,
      processStartedAt: currentProcessStartedAt,
    }
  );
}

export function processIdentityMatches(input: {
  pid?: number | undefined;
  processStartedAt?: string | undefined;
}): boolean {
  if (input.pid === undefined || input.processStartedAt === undefined) {
    return false;
  }

  const current = readProcessIdentity(input.pid);
  return current?.processStartedAt === input.processStartedAt;
}
