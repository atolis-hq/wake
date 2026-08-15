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
  return {
    triggers: [...new Set(input.policies.flatMap(({ policy }) => policy.triggers))],
    async resolve(evidence) {
      const correlations = await input.resources.correlationsForWork(evidence.workItemId);
      const primaries = correlations.filter(({ role }) => role === ResourceCorrelationRole.Primary);
      if (primaries.length !== 1) return null;
      const resource = await input.resources.get(primaries[0]!.resourceId);
      if (resource === null) return null;
      const registration = input.policies.find(({ capabilities }) =>
        capabilities.some((capability) => resource.capabilities.includes(capability)),
      );
      return registration?.policy.resolve(evidence) ?? null;
    },
  };
}
