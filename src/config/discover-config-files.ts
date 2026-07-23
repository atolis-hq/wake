import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const configFileNamePattern = /^config(\..+)?\.yaml$/;

export async function discoverConfigFiles(wakeRoot: string): Promise<string[]> {
  const entries = await readdir(wakeRoot, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isFile() && configFileNamePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(wakeRoot, name));
}
