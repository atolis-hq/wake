import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  emptyFakeScenarios,
  parseFakeScenarios,
  type FakeScenarioResolver,
} from '../execution/index.js';

export async function loadFakeScenarios(wakeRoot: string): Promise<FakeScenarioResolver> {
  const path = join(wakeRoot, 'fake-scenarios.yaml');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFakeScenarios;
    throw error;
  }
  try {
    return parseFakeScenarios(YAML.parse(source) ?? {});
  } catch (error) {
    throw new Error(
      `Fake scenario configuration validation failed in fake-scenarios.yaml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
