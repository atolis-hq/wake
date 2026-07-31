import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { BuiltInActivityName } from '../../src-next/activities/index.js';
import { WorkspaceMode } from '../../src-next/execution/index.js';

describe('Execution vocabulary ownership', () => {
  it('owns WorkspaceMode and Activities owns its Agent name literal independently', async () => {
    const activityVocabulary = await readFile(
      new URL('../../src-next/activities/contracts/vocabulary.ts', import.meta.url),
      'utf8',
    );
    const executionVocabulary = await readFile(
      new URL('../../src-next/execution/contracts/vocabulary.ts', import.meta.url),
      'utf8',
    );

    expect(WorkspaceMode.None).toBe('none');
    expect(executionVocabulary).toMatch(/export const WorkspaceMode/);
    expect(activityVocabulary).not.toMatch(/export const WorkspaceMode/);
    expect(activityVocabulary).toMatch(/Agent:\s*activityName\('agent\.run'\)/);
    expect(BuiltInActivityName.Agent).toBe('agent.run');
  });

  it('preserves the ResourceCapability contract while validating requirements', async () => {
    const executionService = await readFile(
      new URL('../../src-next/execution/application/execution-service.ts', import.meta.url),
      'utf8',
    );

    expect(executionService).toMatch(/requirements: readonly ResourceRequirement\[\]/);
    expect(executionService).not.toMatch(/requirement\.capability as never/);
  });
});
