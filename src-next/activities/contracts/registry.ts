import type {
  ActivityDefinition,
  ActivityExecutionContext,
  ActivityInvocation,
  ActivityOutcome,
  ResourceRequirement,
} from './activity.js';
import { activityName, type ActivityName } from './identifiers.js';
import type { ActivityExecutionKind } from './vocabulary.js';

export interface ActivityDescriptor {
  readonly name: ActivityName;
  readonly outcomeKinds: readonly string[];
  readonly resources: readonly ResourceRequirement[];
  readonly executionKind: ActivityExecutionKind;
}

interface RegistryEntry {
  readonly descriptor: ActivityDescriptor;
  validateInput(input: unknown): unknown;
  validateOutcome(output: unknown): ActivityOutcome;
  execute(
    invocation: ActivityInvocation<unknown>,
    context: ActivityExecutionContext,
  ): Promise<ActivityOutcome>;
}

export class ActivityRegistry {
  private readonly entries = new Map<ActivityName, RegistryEntry>();

  register<Name extends ActivityName, Input, Outcome extends ActivityOutcome>(
    definition: ActivityDefinition<Name, Input, Outcome>,
  ): void {
    activityName(definition.name);
    if (this.entries.has(definition.name))
      throw new Error(`Activity ${definition.name} is already registered`);
    const uniqueKinds = new Set(definition.outcomeKinds);
    if (uniqueKinds.size !== definition.outcomeKinds.length)
      throw new Error(`Duplicate Activity outcome kind declared by ${definition.name}`);
    const descriptor: ActivityDescriptor = Object.freeze({
      name: definition.name,
      outcomeKinds: Object.freeze([...definition.outcomeKinds]),
      resources: Object.freeze([...definition.resources]),
      executionKind: definition.executionKind,
    });
    this.entries.set(definition.name, {
      descriptor,
      validateInput(input) {
        return parse(definition.name, 'input', definition.inputSchema, input);
      },
      validateOutcome(output) {
        assertDeclaredOutcomeKind(descriptor, output);
        return parse(
          definition.name,
          'outcome',
          definition.outcomeSchema,
          output,
        ) as ActivityOutcome;
      },
      async execute(invocation, context) {
        const input = parse(
          definition.name,
          'input',
          definition.inputSchema,
          invocation.input,
        ) as Input;
        const output = await definition.handler.execute({ ...invocation, input }, context);
        assertDeclaredOutcomeKind(descriptor, output);
        return parse(definition.name, 'outcome', definition.outcomeSchema, output) as Outcome;
      },
    });
  }

  describe(name: ActivityName | string): ActivityDescriptor {
    return this.entry(name).descriptor;
  }

  validateInput(name: ActivityName | string, input: unknown): unknown {
    return this.entry(name).validateInput(input);
  }

  validateOutcome(name: ActivityName | string, output: unknown): ActivityOutcome {
    return this.entry(name).validateOutcome(output);
  }

  execute(
    name: ActivityName | string,
    invocation: ActivityInvocation<unknown>,
    context: ActivityExecutionContext,
  ): Promise<ActivityOutcome> {
    return this.entry(name).execute(invocation, context);
  }

  list(): readonly ActivityDescriptor[] {
    return [...this.entries.values()].map((entry) => entry.descriptor);
  }

  private entry(name: ActivityName | string): RegistryEntry {
    const parsedName = activityName(name);
    const entry = this.entries.get(parsedName);
    if (entry === undefined) throw new Error(`Unknown Activity: ${name}`);
    return entry;
  }
}

function assertDeclaredOutcomeKind(definition: ActivityDescriptor, value: unknown): void {
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
