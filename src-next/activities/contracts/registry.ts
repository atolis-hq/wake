import type { ActivityDefinition, ActivityOutcome } from './activity.js';
export class ActivityRegistry {
  private readonly definitions = new Map<string, ActivityDefinition>();
  register(definition: ActivityDefinition): void {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(definition.name))
      throw new Error(`Invalid Activity name: ${definition.name}`);
    if (this.definitions.has(definition.name))
      throw new Error(`Activity ${definition.name} is already registered`);
    this.definitions.set(definition.name, definition);
  }
  get(name: string): ActivityDefinition {
    const definition = this.definitions.get(name);
    if (definition === undefined) throw new Error(`Unknown Activity: ${name}`);
    return definition;
  }
  validateInput(name: string, input: unknown): unknown {
    return parse(name, 'input', this.get(name).inputSchema, input);
  }
  validateOutcome(name: string, output: unknown): ActivityOutcome {
    return parse(name, 'outcome', this.get(name).outcomeSchema, output) as ActivityOutcome;
  }
  list(): readonly ActivityDefinition[] {
    return [...this.definitions.values()];
  }
}
function parse(
  name: string,
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
