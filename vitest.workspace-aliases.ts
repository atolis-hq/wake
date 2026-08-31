import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDirectory = fileURLToPath(new URL('./packages', import.meta.url));

export const workspaceSourceAliases = Object.freeze(
  Object.fromEntries([
    ['@atolis-hq/eventing/memory', join(packagesDirectory, 'eventing', 'src/memory.ts')],
    ...readdirSync(packagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const packageDirectory = join(packagesDirectory, entry.name);
        const sourceEntry = join(packageDirectory, 'src/index.ts');
        if (!existsSync(sourceEntry)) return [];
        const manifest = JSON.parse(
          readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
        ) as { readonly name: string };
        return [[manifest.name, sourceEntry] as const];
      }),
  ]),
);
