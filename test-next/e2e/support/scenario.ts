import { expect, it } from 'vitest';

interface ScenarioDescription {
  readonly id: `E2E-${string}`;
  readonly title: string;
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
}

export function defineScenario(
  description: ScenarioDescription,
  run: () => Promise<void>,
  timeout?: number,
): void {
  const text = [
    `${description.id}: ${description.title}`,
    ...description.given.map((value) => `Given ${value}`),
    ...description.when.map((value) => `When ${value}`),
    ...description.then.map((value) => `Then ${value}`),
  ].join('\n');
  it(
    text,
    async () => {
      expect.hasAssertions();
      await run();
    },
    timeout,
  );
}
