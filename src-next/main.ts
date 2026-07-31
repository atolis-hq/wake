import { createCompositionRoot } from './bootstrap/index.js';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'tick';
  if (command !== 'tick') throw new Error(`Unsupported target command: ${command}`);
  const runtime = await createCompositionRoot(process.cwd());
  await runtime.projectionRunner.runRegisteredOnce();
  await runtime.advanceOnce({ maxProgress: 1 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
