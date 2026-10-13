import { expect, it } from 'vitest';
import {
  isReviewAuthorized,
  ProviderPermission,
  ReviewActorKind,
  ReviewerAuthorizationSource,
} from '../../../../src/activities/index.js';
import { isWorkControlAuthorized } from '../../../../src/integrations/github/application/work-control-authorization.js';

it.each([ProviderPermission.Write, ProviderPermission.Maintain, ProviderPermission.Admin])(
  'permits %s human work control while denying author self-review',
  (permission) => {
    const input = {
      actorId: 'Maintainer',
      resourceAuthorId: 'maintainer',
      actorKind: ReviewActorKind.Human,
      authorization: { source: ReviewerAuthorizationSource.ProviderPermission, permission },
    } as const;
    expect(isWorkControlAuthorized(input)).toBe(true);
    expect(isReviewAuthorized(input)).toBe(false);
  },
);

it.each([ProviderPermission.Read, ProviderPermission.Triage, ProviderPermission.None])(
  'denies %s repository work control',
  (permission) => {
    expect(
      isWorkControlAuthorized({
        actorKind: ReviewActorKind.Human,
        authorization: { source: ReviewerAuthorizationSource.ProviderPermission, permission },
      }),
    ).toBe(false);
  },
);

it('denies bot and unverified work control and keeps configured self-review denied', () => {
  expect(
    isWorkControlAuthorized({
      actorKind: ReviewActorKind.Bot,
      authorization: {
        source: ReviewerAuthorizationSource.ProviderPermission,
        permission: ProviderPermission.Admin,
      },
    }),
  ).toBe(false);
  expect(
    isWorkControlAuthorized({
      actorKind: ReviewActorKind.Human,
      authorization: { source: ReviewerAuthorizationSource.None },
    }),
  ).toBe(false);
  expect(
    isReviewAuthorized({
      actorId: 'author',
      resourceAuthorId: 'author',
      actorKind: ReviewActorKind.Human,
      authorization: {
        source: ReviewerAuthorizationSource.ConfiguredReviewer,
        reviewerId: 'author',
      },
    }),
  ).toBe(false);
});
