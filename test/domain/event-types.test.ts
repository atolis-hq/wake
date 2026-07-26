import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { wakeEventTypeDefinitions, wakeEventTypeValues } from '../../src/domain/event-types.js';

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(path);
      }
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('Wake event type catalog', () => {
  it('keeps event values and definitions in sync', () => {
    expect(wakeEventTypeDefinitions.map((entry) => entry.type)).toEqual(wakeEventTypeValues);
  });

  it('lists every Wake event type in docs/events.md', async () => {
    const docs = await readFile('docs/events.md', 'utf8');

    for (const type of wakeEventTypeValues) {
      expect(docs).toContain(`\`${type}\``);
    }
  });

  it('keeps production Wake event literals centralized', async () => {
    const files = (await listTypeScriptFiles('src')).filter(
      (file) => !file.endsWith(join('src', 'domain', 'event-types.ts')),
    );
    const inlineWakeEvent = /(?:sourceEventType:\s*|[!=]==\s*)'wake\.[^']+'/;

    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      expect(contents, file).not.toMatch(inlineWakeEvent);
    }
  });
});
