#!/usr/bin/env node
const args = process.argv.slice(2);
const mode = args.at(-1);
if (
  !args.includes('stream-json') ||
  !args.includes('--verbose') ||
  !args.includes('--include-partial-messages')
)
  process.exit(2);
const final = () =>
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      result: 'Finished café. [[STATUS: DONE]]',
      session_id: 'resumed-session',
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
      total_cost_usd: 0.02,
    }),
  );
if (mode === 'buffered') {
  setTimeout(final, 80);
} else if (mode === 'silent') {
  setInterval(() => {}, 1000);
} else {
  let count = 0;
  const timer = setInterval(() => {
    process.stdout.write(
      JSON.stringify({
        type: mode === 'noise' ? 'system' : count % 2 ? 'user' : 'stream_event',
        message: 'x'.repeat(64000),
      }) + '\n',
    );
    if (++count === 25 && mode === 'progress') {
      clearInterval(timer);
      final();
    }
  }, 40);
}
