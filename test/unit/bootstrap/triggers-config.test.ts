import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../../src/bootstrap/index.js';
import { ExecutionEventType } from '../../../src/execution/index.js';

function parse(trigger: unknown, controlPlane?: unknown) {
  return parseRootConfig({
    execution: { defaultRunnerPool: 'standard' },
    orchestration: {
      default: 'review',
      workflows: {
        review: { stages: { inspect: { activity: 'agent', on: { done: { then: 'done' } } } } },
      },
    },
    controlPlane: controlPlane ?? { triggers: [trigger] },
  });
}

const trigger = { id: 'review', workflow: 'review', on: { cron: '*/5 * * * *' } };

describe('workflow trigger configuration', () => {
  it('accepts cron, canonical events and combined independent sources', () => {
    for (const on of [
      trigger.on,
      { events: [ExecutionEventType.RunSucceeded] },
      { ...trigger.on, events: [ExecutionEventType.RunFailed] },
    ]) {
      expect(
        parse({ ...trigger, on, when: { capacityAvailable: true } }).controlPlane.triggers,
      ).toHaveLength(1);
    }
  });

  it.each([
    { ...trigger, on: undefined },
    { ...trigger, on: {} },
    { ...trigger, on: { events: [] } },
    { ...trigger, on: { events: ['unknown.event'] } },
    { ...trigger, on: { cron: '* * * * * *' } },
    { ...trigger, on: { cron: '60 * * * *' } },
    { ...trigger, workflow: 'unknown' },
    { ...trigger, id: '' },
    { ...trigger, objective: 'task' },
    { ...trigger, minIntervalMs: 1000 },
    { ...trigger, contextScope: 'shared' },
    { ...trigger, when: { capacityAvailable: false } },
    { ...trigger, when: { capacityAvailable: 'true' } },
    { ...trigger, when: { arbitrary: true } },
    { ...trigger, on: { intervalMs: 1000 } },
  ])('rejects unsupported or malformed definitions (%j)', (value) => {
    expect(() => parse(value)).toThrow();
  });

  it('rejects schedules and duplicate trigger identities', () => {
    expect(() => parse(trigger, { schedules: [] })).toThrow();
    expect(() => parse(trigger, { triggers: [trigger, trigger] })).toThrow();
  });
});
