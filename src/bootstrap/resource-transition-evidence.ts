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
      for (const correlation of correlations) {
        if (correlation.role !== ResourceCorrelationRole.Primary) continue;
        const resource = await input.resources.get(correlation.resourceId);
        if (resource === null) continue;
        const registration = input.policies.find(({ capabilities }) =>
          capabilities.some((capability) => resource.capabilities.includes(capability)),
        );
        if (registration === undefined) continue;
        const resolved = await registration.policy.resolve(evidence);
        if (resolved !== null) return resolved;
      }
      return null;
    },
  };
}
