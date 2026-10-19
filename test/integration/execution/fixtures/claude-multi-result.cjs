#!/usr/bin/env node
// Reproduces #983: a backgrounded task makes Claude emit two result events.
const mode = process.argv.at(-1);
const line = (event) => JSON.stringify(event) + '\n';
if (mode === 'no-result') {
  process.stdout.write(line({ type: 'assistant', message: {} }));
} else if (mode === 'bad-final') {
  process.stdout.write(line({ type: 'result', result: 'intermediate' }));
  process.stdout.write(line({ type: 'result', result: 42 }));
} else {
  process.stdout.write(line({ type: 'assistant', message: {} }));
  process.stdout.write(
    line({
      type: 'result',
      result: "The install is running in the background; I'll continue when it finishes.",
      session_id: 'session-1',
      usage: { input_tokens: 1, output_tokens: 2 },
    }),
  );
  process.stdout.write(
    line({
      type: 'result',
      result: 'Parallel stages on desktop now stack. [[STATUS: DONE]]',
      session_id: 'session-2',
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.5,
      origin: { kind: 'task-notification' },
    }),
  );
}
