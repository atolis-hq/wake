import {
  maximumCapturedProcessOutputBytes,
  type ProcessStdoutDecoder,
} from '../process-execution.js';

function isProgress(type: unknown): boolean {
  return type === 'assistant' || type === 'user' || type === 'stream_event';
}

// Kept result lines are newline-terminated so several results stay line-delimited.
function terminated(line: Buffer): Buffer {
  return line.length === 0 || line[line.length - 1] === 10
    ? line
    : Buffer.concat([line, Buffer.from('\n')]);
}

function decode(line: Buffer) {
  try {
    const value = JSON.parse(line.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { output: Buffer.alloc(0), activity: false };
    const event = value as Record<string, unknown>;
    const final =
      event.type === 'result' || (event.type === undefined && typeof event.result === 'string');
    return {
      output: final ? terminated(line) : Buffer.alloc(0),
      activity: final || isProgress(event.type),
    };
  } catch {
    return { output: Buffer.alloc(0), activity: false, diagnostic: line };
  }
}

// Claude envelopes put their type before the potentially large tool payload.
function envelopeType(prefix: Buffer): string | undefined {
  return /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(prefix.toString('utf8'))?.[1];
}

export function createClaudeStreamDecoder(): ProcessStdoutDecoder {
  let pending = Buffer.alloc(0);
  let finalSeen = false;
  const diagnostics: Buffer[] = [];
  let diagnosticBytes = 0;
  const decodeRecord = (line: Buffer) => {
    const decoded = decode(line);
    finalSeen ||= decoded.output.length > 0;
    if (decoded.diagnostic !== undefined && diagnosticBytes < maximumCapturedProcessOutputBytes) {
      const captured = decoded.diagnostic.subarray(
        0,
        maximumCapturedProcessOutputBytes - diagnosticBytes,
      );
      if (captured.length > 0) {
        diagnostics.push(captured);
        diagnosticBytes += captured.length;
      }
    }
    return decoded;
  };
  let recordType: string | undefined;
  let discarding = false;
  let discardedActivity = false;
  const append = (part: Buffer): boolean => {
    if (part.length === 0) return false;
    if (discarding) return discardedActivity;
    const remaining = maximumCapturedProcessOutputBytes - pending.length;
    if (part.length <= remaining) {
      pending = Buffer.concat([pending, part]);
      recordType ??= envelopeType(pending.subarray(0, 4096));
      return isProgress(recordType);
    }
    const prefix = Buffer.concat([pending, part.subarray(0, remaining)]);
    const type = recordType ?? envelopeType(prefix);
    if (type === 'result') throw new Error('Claude final result exceeds output limit');
    discardedActivity = isProgress(type);
    discarding = true;
    pending = Buffer.alloc(0);
    return discardedActivity;
  };
  return {
    push(chunk) {
      const outputs: Buffer[] = [];
      let activity = false;
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        activity = append(chunk.subarray(start, end)) || activity;
        if (!discarding && pending.length > 0) {
          const decoded = decodeRecord(pending);
          if (decoded.output.length > 0) outputs.push(decoded.output);
          activity ||= decoded.activity;
        }
        pending = Buffer.alloc(0);
        recordType = undefined;
        discarding = false;
        discardedActivity = false;
        start = end + 1;
      }
      activity = append(chunk.subarray(start)) || activity;
      return { output: Buffer.concat(outputs), activity };
    },
    finish() {
      const output =
        discarding || pending.length === 0 ? Buffer.alloc(0) : decodeRecord(pending).output;
      pending = Buffer.alloc(0);
      return finalSeen ? output : Buffer.concat(diagnostics);
    },
  };
}
