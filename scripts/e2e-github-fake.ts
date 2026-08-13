import { access, cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCompositionRoot,
  createSurfaceApplications,
  resolveWakePaths,
} from '../src/bootstrap/index.js';
import { main } from '../src/main.js';

async function tick(wakeRoot: string): Promise<void> {
  await main(['tick', '--wake-root', wakeRoot], {
    compose: async (root) => createSurfaceApplications(await createCompositionRoot(root)).cli,
    output: { write() {} },
    signal: new AbortController().signal,
  });
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Legacy state was created at ${path}`);
}

export async function runTargetFakeGitHubE2e(
  repoRoot = process.cwd(),
): Promise<{ wakeRoot: string }> {
  const wakeRoot = await mkdtemp(join(tmpdir(), 'wake-github-fake-next-'));
  const cleanup = !process.argv.includes('--keep');
  try {
    await cp(join(repoRoot, 'test', 'e2e', 'fixtures', 'wake-root'), wakeRoot, {
      recursive: true,
    });
    await tick(wakeRoot);
    await tick(wakeRoot);

    const paths = resolveWakePaths(wakeRoot);
    if ((await readdir(paths.eventsRoot)).length === 0) throw new Error('Target journal is empty');
    if ((await readdir(paths.projectionsRoot)).length === 0)
      throw new Error('Target projections are empty');
    await assertAbsent(join(wakeRoot, 'state'));
    await assertAbsent(join(wakeRoot, 'runs'));
    await assertAbsent(join(wakeRoot, 'config.json'));
    return { wakeRoot };
  } finally {
    if (cleanup) await rm(wakeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTargetFakeGitHubE2e().then(
    ({ wakeRoot }) => console.log(JSON.stringify({ ok: true, wakeRoot })),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
