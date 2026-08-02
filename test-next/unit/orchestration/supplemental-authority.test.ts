import { describe, expect, it } from 'vitest';
import { EventActorKind } from '../../../src-next/kernel/index.js';
import { isAuthorisedActor } from '../../../src-next/orchestration/domain/supplemental-policy.js';
import { ApprovalAuthorityKind } from '../../../src-next/orchestration/index.js';

const humanOnly = [ApprovalAuthorityKind.Human] as const;
const autoOnly = [ApprovalAuthorityKind.Auto] as const;

describe('supplemental command actor authority', () => {
  it('treats an operator as human', () => {
    expect(isAuthorisedActor(humanOnly, EventActorKind.Operator)).toBe(true);
  });

  // A provider relays a person typing in a ticket comment. D16 counts a person as `human`
  // on any surface, so the transport that carried the command must not change who they are.
  it('treats a provider-relayed invocation as human, not auto', () => {
    expect(isAuthorisedActor(humanOnly, EventActorKind.Integration)).toBe(true);
  });

  // `auto` requires durable operator consent. Inferring it from an actor kind would grant
  // it with no consent anywhere in the decision.
  it('never grants auto authority from an actor kind alone', () => {
    for (const actorKind of Object.values(EventActorKind))
      expect(isAuthorisedActor(autoOnly, actorKind)).toBe(false);
  });

  it('refuses an agent and the system entirely', () => {
    expect(isAuthorisedActor(humanOnly, EventActorKind.Agent)).toBe(false);
    expect(isAuthorisedActor(humanOnly, EventActorKind.System)).toBe(false);
  });
});
