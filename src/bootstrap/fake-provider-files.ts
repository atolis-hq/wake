import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { IntegrationsConfig } from '../integrations/index.js';

const fakeFileConfigSchema = z
  .object({
    provider: z.literal('fake'),
    evidenceFile: z.string().min(1),
    effectsFile: z.string().min(1).optional(),
  })
  .passthrough();

/** Resolves fake-provider evidence files before providers are composed. */
export async function hydrateFakeProviderEvidence(
  wakeRoot: string,
  integrations: IntegrationsConfig,
): Promise<IntegrationsConfig> {
  const entries = await Promise.all(
    Object.entries(integrations).map(async ([name, entry]) => {
      const parsed = fakeFileConfigSchema.safeParse(entry);
      if (!parsed.success) return [name, entry];
      const events = JSON.parse(await readFile(join(wakeRoot, parsed.data.evidenceFile), 'utf8'));
      const effectsPath =
        parsed.data.effectsFile === undefined ? undefined : join(wakeRoot, parsed.data.effectsFile);
      const deliveryEffects = effectsPath === undefined ? {} : await readEffectsFile(effectsPath);
      return [
        name,
        {
          ...entry,
          events,
          deliveryEffects,
          ...(effectsPath === undefined ? {} : { effectsFile: effectsPath }),
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

async function readEffectsFile(path: string): Promise<Record<string, string>> {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
