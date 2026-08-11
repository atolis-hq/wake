import { describe, expect } from 'vitest';
import { defineScenario } from './support/scenario.js';
import { TestWorld } from './support/world.js';

describe('event-model scenario harness', () => {
  defineScenario(
    {
      id: 'E2E-HARNESS-001',
      title: 'causal traces are readable',
      given: ['a deterministic world'],
      when: ['one event is appended'],
      then: ['the trace names the event and causation'],
    },
    async () => {
      const world = new TestWorld();
      await world.appendFact('work.item-created', { objective: 'test' }, 'cmd-1');
      expect(await world.trace()).toBe(
        '1 work.item-created stream=test:scenario cause=cmd-1 payload={"objective":"test"}',
      );
    },
  );
});
