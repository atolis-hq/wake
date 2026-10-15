import { readFileSync, readlinkSync } from 'node:fs';
import { z } from 'zod';
import { ExternalExecutionKind } from '../../activities/index.js';
import type { ExternalExecutionInspector } from '../application/recovery-service.js';
import { ExternalExecutionState } from '../contracts/vocabulary.js';

interface ProcessIdentity {
  readonly boot: string;
  readonly namespace: string;
  readonly pid: number;
  readonly start: string;
}

function environment() {
  return {
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    namespace: readlinkSync('/proc/self/ns/pid'),
  };
}

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const start = fields[19];
  if (fields[0] === 'Z' || fields[0] === 'X') return 'terminated';
  if (start === undefined || !/^\d+$/.test(start)) throw new Error('Invalid process stat');
  return start;
}

/** Opaque identity includes PID reuse protection and the inspection environment. */
export function localProcessIdentity(pid: number | undefined): string | undefined {
  if (pid === undefined || process.platform !== 'linux') return undefined;
  try {
    const start = processStart(pid);
    if (start === 'terminated') return undefined;
    return JSON.stringify({ ...environment(), pid, start });
  } catch {
    return undefined;
  }
}

const processIdentitySchema = z
  .object({
    boot: z.string().min(1),
    namespace: z.string().min(1),
    pid: z.number().int().positive().safe(),
    start: z.string().regex(/^\d+$/),
  })
  .strict();

function decodeIdentity(id: string): ProcessIdentity | undefined {
  try {
    const parsed = processIdentitySchema.safeParse(JSON.parse(id));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function createLocalProcessInspector(): ExternalExecutionInspector {
  return {
    async inspect(reference) {
      const unknown = (reason: string) => ({ kind: ExternalExecutionState.Unknown, reason });
      const identity = decodeIdentity(reference.id);
      if (
        reference.kind !== ExternalExecutionKind.Process ||
        identity === undefined ||
        process.platform !== 'linux'
      )
        return unknown(
          'No inspectable local process identity; verify the runner has stopped, then resolve the ambiguous run',
        );
      try {
        const current = environment();
        if (current.boot !== identity.boot) return { kind: ExternalExecutionState.Absent };
        if (current.namespace !== identity.namespace)
          return unknown(
            'Runner PID namespace changed; verify the previous container has stopped, then resolve the ambiguous run',
          );
        try {
          return {
            kind:
              processStart(identity.pid) === identity.start
                ? ExternalExecutionState.Running
                : ExternalExecutionState.Absent,
          };
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return { kind: ExternalExecutionState.Absent };
          throw error;
        }
      } catch {
        return unknown(
          'Local process inspection failed; restore /proc access or verify the runner has stopped and resolve the ambiguous run',
        );
      }
    },
  };
}
