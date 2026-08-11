import { BuiltInResourceCapability, type ResourceCapability } from '../../resources/index.js';

// A resource is PR-shaped by what it can do, never by its registered kind —
// a provider may model a mergeable resource under a different kind entirely.
const PULL_REQUEST_CAPABILITIES: readonly ResourceCapability[] = [
  BuiltInResourceCapability.Mergeable,
  BuiltInResourceCapability.Reviewable,
  BuiltInResourceCapability.Approvable,
];

export function isPullRequestLikeResource(capabilities: readonly ResourceCapability[]): boolean {
  return PULL_REQUEST_CAPABILITIES.some((capability) => capabilities.includes(capability));
}
