import { expect, it } from 'vitest';
import { workflowDefinitionConfigSchema } from '../../../src/orchestration/contracts/config.js';
import { assertConfiguredOutputs } from '../../../src/orchestration/domain/assignment-output-requirements.js';

const configured = {
  api: { kind: 'change' as const },
  notes: { kind: 'artifact' as const, required: false },
};
it('preserves configured required outputs and allows strengthening optional requirements', () => {
  const config = workflowDefinitionConfigSchema.parse({
    outputs: configured,
    stages: { work: { activity: 'agent', on: { done: { then: 'done' } } } },
  });
  expect(config.outputs).toEqual(configured);
  expect(() =>
    assertConfiguredOutputs(config.outputs, [
      { name: 'api', kind: 'change' },
      { name: 'notes', path: 'notes.md', required: true },
    ]),
  ).not.toThrow();
  expect(() =>
    assertConfiguredOutputs(config.outputs, [{ name: 'api', kind: 'change' }]),
  ).not.toThrow();
  expect(() =>
    assertConfiguredOutputs(config.outputs, [{ name: 'notes', path: 'notes.md' }]),
  ).toThrow('Missing configured required output');
  expect(() =>
    assertConfiguredOutputs(config.outputs, [{ name: 'api', kind: 'change', required: false }]),
  ).toThrow('weakens');
  expect(() => assertConfiguredOutputs(config.outputs, [{ name: 'api', path: 'api.md' }])).toThrow(
    'weakens',
  );
});
