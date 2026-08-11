import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';
import {
  resourceCapability,
  resourceKind,
  type ResourceCapability,
  type ResourceKind,
} from './identifiers.js';

export const BuiltInResourceKind = {
  Repository: resourceKind('repository'),
  Issue: resourceKind('issue'),
  PullRequest: resourceKind('pull-request'),
} as const;

export const BuiltInResourceCapability = {
  Commentable: resourceCapability('commentable'),
  Reviewable: resourceCapability('reviewable'),
  Approvable: resourceCapability('approvable'),
  Mergeable: resourceCapability('mergeable'),
  Revisioned: resourceCapability('revisioned'),
  Editable: resourceCapability('editable'),
  // Provider can report which file paths a revision changed.
  ChangedFiles: resourceCapability('changed-files'),
} as const;

export const ResourceCorrelationRole = defineClosedVocabulary({
  Primary: 'primary',
  Secondary: 'secondary',
} as const);

export type ResourceCorrelationRole = ValueOf<typeof ResourceCorrelationRole>;

export const ResourceCorrelationProvenance = defineClosedVocabulary({
  ProviderObserved: 'provider-observed',
  AgentReported: 'agent-reported',
  OperatorDeclared: 'operator-declared',
} as const);

export type ResourceCorrelationProvenance = ValueOf<typeof ResourceCorrelationProvenance>;

abstract class OpenResourceVocabularyRegistry<Value extends string> {
  private readonly values = new Set<Value>();

  protected constructor(
    initial: readonly Value[],
    private readonly parse: (value: string) => Value,
    private readonly label: string,
  ) {
    for (const value of initial) this.register(value);
  }

  register(value: Value): void {
    const parsed = this.parse(value);
    if (this.values.has(parsed)) throw new Error(`${this.label} ${value} is already registered`);
    this.values.add(parsed);
  }

  resolve(value: string): Value {
    const parsed = this.parse(value);
    if (!this.values.has(parsed)) throw new Error(`Unknown ${this.label}: ${value}`);
    return parsed;
  }

  has(value: string): boolean {
    try {
      return this.values.has(this.parse(value));
    } catch {
      return false;
    }
  }
}

export class ResourceKindRegistry extends OpenResourceVocabularyRegistry<ResourceKind> {
  constructor(initial: readonly ResourceKind[] = []) {
    super(initial, resourceKind, 'Resource kind');
  }
}

export class ResourceCapabilityRegistry extends OpenResourceVocabularyRegistry<ResourceCapability> {
  constructor(initial: readonly ResourceCapability[] = []) {
    super(initial, resourceCapability, 'Resource capability');
  }
}
