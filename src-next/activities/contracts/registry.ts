import type {
  ActivityDefinition,
  ActivityExecutionContext,
  ActivityInvocation,
  ActivityOutcome,
} from './activity.js';
import { activityName, type ActivityName } from './identifiers.js';
import type { z } from 'zod';

type InputOf<Definition extends ActivityDefinition> = z.output<Definition['inputSchema']>;
type OutcomeOf<Definition extends ActivityDefinition> = z.output<Definition['outcomeSchema']>;

export class ActivityRegistry {
  private readonly definitions = new Map<ActivityName, unknown>();

  register<Name extends ActivityName, Input, Outcome extends ActivityOutcome>(
    definition: ActivityDefinition<Name, Input, Outcome>,
  ): void {
    activityName(definition.name);
    if (this.definitions.has(definition.name))
      throw new Error(`Activity ${definition.name} is already registered`);
    const uniqueKinds = new Set(definition.outcomeKinds);
    if (uniqueKinds.size !== definition.outcomeKinds.length)
      throw new Error(`Duplicate Activity outcome kind declared by ${definition.name}`);
    this.definitions.set(definition.name, definition);
  }

  get<Definition extends ActivityDefinition = ActivityDefinition>(
    name: Definition['name'] | string,
  ): Definition {
    const parsedName = activityName(name);
    const definition = this.definitions.get(parsedName);
    if (definition === undefined) throw new Error(`Unknown Activity: ${name}`);
    return definition as Definition;
  }

  validateInput<Definition extends ActivityDefinition>(
    definition: Definition,
    input: unknown,
  ): InputOf<Definition>;
  validateInput(name: ActivityName | string, input: unknown): unknown;
  validateInput(
    definitionOrName: ActivityDefinition | ActivityName | string,
    input: unknown,
  ): unknown {
    const definition =
      typeof definitionOrName === 'string'
        ? this.get(activityName(definitionOrName))
        : definitionOrName;
    return parse(definition.name, 'input', definition.inputSchema, input);
  }

  validateOutcome<Definition extends ActivityDefinition>(
    definition: Definition,
    output: unknown,
  ): OutcomeOf<Definition>;
  validateOutcome(name: ActivityName | string, output: unknown): ActivityOutcome;
  validateOutcome(
    definitionOrName: ActivityDefinition | ActivityName | string,
    output: unknown,
  ): ActivityOutcome {
    const definition =
      typeof definitionOrName === 'string'
        ? this.get(activityName(definitionOrName))
        : definitionOrName;
    assertDeclaredOutcomeKind(definition, output);
    const parsed = parse(
      definition.name,
      'outcome',
      definition.outcomeSchema,
      output,
    ) as ActivityOutcome;
    return parsed;
  }

  async execute<Definition extends ActivityDefinition>(
    definition: Definition,
    invocation: ActivityInvocation<InputOf<Definition>>,
    context: ActivityExecutionContext,
  ): Promise<OutcomeOf<Definition>> {
    const input = parse(
      definition.name,
      'input',
      definition.inputSchema,
      invocation.input,
    ) as InputOf<Definition>;
    const output = await definition.handler.execute({ ...invocation, input }, context);
    assertDeclaredOutcomeKind(definition, output);
    const parsed = parse(
      definition.name,
      'outcome',
      definition.outcomeSchema,
      output,
    ) as OutcomeOf<Definition>;
    return parsed;
  }

  list(): readonly ActivityDefinition[] {
    return [...this.definitions.values()] as ActivityDefinition[];
  }
}

function assertDeclaredOutcomeKind(definition: ActivityDefinition, value: unknown): void {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return;
  const kind = Reflect.get(value, 'kind');
  if (typeof kind === 'string' && !definition.outcomeKinds.includes(kind))
    throw new Error(`Undeclared Activity outcome kind ${kind} returned by ${definition.name}`);
}

function parse(
  name: ActivityName | string,
  kind: string,
  schema: {
    safeParse(value: unknown): {
      success: boolean;
      data?: unknown;
      error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] };
    };
  },
  value: unknown,
): unknown {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues =
    parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') ??
    'invalid value';
  throw new Error(`Activity ${name} ${kind} invalid: ${issues}`);
}
