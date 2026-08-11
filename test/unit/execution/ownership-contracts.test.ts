import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { BuiltInActivityName } from '../../../src/activities/index.js';
import { WorkspaceMode } from '../../../src/execution/index.js';

describe('Execution vocabulary ownership', () => {
  it('owns WorkspaceMode and Activities owns its Agent name literal independently', async () => {
    const activityVocabulary = await readFile(
      new URL('../../../src/activities/contracts/vocabulary.ts', import.meta.url),
      'utf8',
    );
    const executionVocabulary = await readFile(
      new URL('../../../src/execution/contracts/vocabulary.ts', import.meta.url),
      'utf8',
    );

    expect(WorkspaceMode.None).toBe('none');
    expect(executionVocabulary).toMatch(/export const WorkspaceMode/);
    expect(activityVocabulary).not.toMatch(/export const WorkspaceMode/);
    expect(activityVocabulary).toMatch(/Agent:\s*activityName\(ActivityExecutionKind\.Agent\)/);
    expect(BuiltInActivityName.Agent).toBe('agent');
  });

  it('preserves the ResourceCapability contract while validating requirements', async () => {
    const executionService = await readFile(
      new URL('../../../src/execution/application/execution-service.ts', import.meta.url),
      'utf8',
    );

    expect(executionService).toMatch(/requirements: readonly ResourceRequirement\[\]/);
    expect(executionService).not.toMatch(/requirement\.capability as never/);
  });
});
