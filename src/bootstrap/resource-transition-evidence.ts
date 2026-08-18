import type { ResourceTransitionEvidence } from '../orchestration/index.js';
import type { ResourceService } from '../resources/index.js';
import { ResourceCorrelationRole, type ResourceCapability } from '../resources/index.js';

export interface ResourceTransitionEvidencePolicyRegistration {
  readonly capabilities: readonly ResourceCapability[];
  readonly policy: ResourceTransitionEvidence;
}

export function createCapabilityResourceTransitionEvidence(input: {
  readonly resources: ResourceService;
  readonly policies: readonly ResourceTransitionEvidencePolicyRegistration[];
}): ResourceTransitionEvidence {
  const registrationFor = (
    capabilities: readonly ResourceCapability[],
  ): ResourceTransitionEvidencePolicyRegistration | undefined =>
    input.policies.find((registration) =>
      registration.capabilities.some((capability) => capabilities.includes(capability)),
    );
  return {
    triggers: [...new Set(input.policies.flatMap(({ policy }) => policy.triggers))],
    async resolve(evidence) {
      // A work item may hold several primary correlations (e.g. its
      // originating issue and an implementation PR). Only the correlation
      // whose resource matches a registered policy's capabilities is
      // relevant here; the rest drop out rather than blocking resolution.
      const correlations = await input.resources.correlationsForWork(evidence.workItemId);
      const primaries = correlations.filter(({ role }) => role === ResourceCorrelationRole.Primary);
      const registrations: ResourceTransitionEvidencePolicyRegistration[] = [];
      for (const primary of primaries) {
        const resource = await input.resources.get(primary.resourceId);
        if (resource === null) continue;
        const registration = registrationFor(resource.capabilities);
        if (registration !== undefined) registrations.push(registration);
      }
      if (registrations.length !== 1) return null;
      return registrations[0]!.policy.resolve(evidence);
    },
  };
}
