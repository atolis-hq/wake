import {
  maximumCapturedProcessOutputBytes,
  type ProcessStdoutDecoder,
} from '../process-execution.js';

// Discard progress after observing it so long sessions do not retain transcripts.
export function createClaudeStreamDecoder(): ProcessStdoutDecoder {
  let pending = Buffer.alloc(0);
  const decode = (line: Buffer) => {
    try {
      const value = JSON.parse(line.toString('utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { output: Buffer.alloc(0), activity: false };
      const event = value as Record<string, unknown>;
      const final =
        event.type === 'result' || (event.type === undefined && typeof event.result === 'string');
      return {
        output: final ? line : Buffer.alloc(0),
        activity:
          final ||
          event.type === 'assistant' ||
          event.type === 'user' ||
          event.type === 'stream_event',
      };
    } catch {
      return { output: Buffer.alloc(0), activity: false };
    }
  };
  return {
    push(chunk) {
      const outputs: Buffer[] = [];
      let activity = false;
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        if (pending.length + part.length > maximumCapturedProcessOutputBytes)
          throw new Error('Claude event exceeds output limit');
        if (pending.length === 0 && part.length === 0) {
          start = end + 1;
          continue;
        }
        const decoded = decode(Buffer.concat([pending, part]));
        if (decoded.output.length > 0) outputs.push(decoded.output);
        activity ||= decoded.activity;
        pending = Buffer.alloc(0);
        start = end + 1;
      }
      if (pending.length + chunk.length - start > maximumCapturedProcessOutputBytes)
        throw new Error('Claude event exceeds output limit');
      pending = Buffer.concat([pending, chunk.subarray(start)]);
      return { output: Buffer.concat(outputs), activity };
    },
    finish() {
      const output = decode(pending).output;
      pending = Buffer.alloc(0);
      return output;
    },
  };
}
