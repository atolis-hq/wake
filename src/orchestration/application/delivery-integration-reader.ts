import type { DeliveryDependencies } from '../contracts/delivery-ports.js';
import { currentSelection, isChange, type DeliveryFacts } from '../domain/delivery-facts.js';
import {
  assessIntegration,
  type IntegrationAssessment,
  type PullRequestObservation,
} from '../domain/delivery-integration.js';

/** Reads the provider and Work facts the pure integration decision needs, fresh on every call. */
export class DeliveryIntegrationReader {
  constructor(private readonly dependencies: DeliveryDependencies) {}

  async assess(facts: DeliveryFacts): Promise<IntegrationAssessment> {
    const changes = (currentSelection(facts)?.entries ?? []).flatMap((entry) =>
      isChange(entry.output)
        ? [{ child: entry.childWorkItemId as string, reference: entry.output.reference }]
        : [],
    );
    const observations = new Map<string, PullRequestObservation>();
    for (const { reference } of changes) {
      const observed = await this.dependencies.integration?.observe(reference.resourceId);
      if (observed !== undefined && observed !== null)
        observations.set(reference.resourceId, observed);
    }
    const held =
      (await this.dependencies.unavailable?.(changes.map((change) => change.child))) ??
      new Map<string, string>();
    return assessIntegration(facts, observations, held);
  }
}
