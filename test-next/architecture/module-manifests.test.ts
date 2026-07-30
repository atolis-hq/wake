import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const modules = [
  'kernel',
  'persistence',
  'work',
  'resources',
  'activities',
  'orchestration',
  'execution',
  'control-plane',
  'integrations',
  'surfaces',
  'bootstrap',
] as const;

describe('module manifests', () => {
  it.each(modules)('%s has matching human and machine contracts', async (name) => {
    const manifest = JSON.parse(await readFile(`src-next/${name}/module.json`, 'utf8')) as {
      name: string;
      publicEntry: string;
    };
    const moduleDoc = await readFile(`src-next/${name}/MODULE.md`, 'utf8');
    expect(manifest.name).toBe(name);
    expect(manifest.publicEntry).toBe('./index.ts');
    expect(moduleDoc).toContain(`# ${name}`);
    expect(moduleDoc).toContain('## Does not own');
    expect(moduleDoc).toContain('## Invariants');
  });
});
