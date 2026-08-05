# Resource Card Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each work item's correlated resource as a clickable card with a provider icon, human-readable title/locator, and an external link out to GitHub, instead of the current plain `<li>` showing the raw internal `resourceId`.

**Architecture:** Thread an optional `title` through the `resources` domain (captured once at discovery), add a per-adapter `ResourceLinkResolver` owned by each integration (GitHub's parses `owner/repo#number` into a GitHub URL), resolve it at the `surfaces/api` presenter boundary into a browser-safe `ResourceItemResponse`, and render it as a card in `work.tsx` using two small hand-rolled icon components (no new dependency).

**Tech Stack:** TypeScript, zod (event schemas), Vitest, React, `@testing-library/react`.

## Global Constraints

- `resources` module may depend only on `kernel`, `work` (`src-next/resources/module.json`) — no `integrations`/`surfaces` imports there, ever.
- `resources/contracts/events.ts` zod schemas are `.strict()` — new payload fields must be `.optional()` so historical events without them still decode.
- `surfaces/web/src` may only import from itself or `surfaces/api/contracts` (`browser-imports-only-surface-transport-contracts` rule) — no direct imports of `resources`/`integrations` domain types in the browser bundle.
- `composition-root.ts` may only import a provider's public barrel (`integrations/github/index.ts`), never its internal files (`compositionRootBarrelRule`).
- Run `npm run lint:contracts`, `npm run lint:architecture`, `npm run knip:next`, and `npm run verify:next` before considering any task in this plan done. Until Task 28's legacy-replacement gate lands, also run `npm run verify`.
- No new npm dependency for icons — hand-roll inline SVG React components, matching this codebase's existing precedent (no icon library in `surfaces/web/package.json` today).

---

### Task 1: Add an optional `title` to the Resource domain

**Files:**
- Modify: `src-next/resources/contracts/events.ts` (`ResourceDiscoveredPayload`, zod schema)
- Modify: `src-next/resources/contracts/views.ts` (`ResourceView`)
- Modify: `src-next/resources/contracts/commands.ts` (`DiscoverResource`)
- Modify: `src-next/resources/domain/resource.ts` (`discoveredResource`)
- Modify: `src-next/resources/application/resource-projections.ts` (`resourceProjection.project`, `ResourceDiscovered` case)
- Modify: `src-next/resources/application/resource-service.ts` (`discoverResource`)
- Test: `test-next/unit/resources/event-contracts.test.ts`
- Test: `test-next/unit/resources/correlation.test.ts`

**Interfaces:**
- Produces: `ResourceDiscoveredPayload.title?: string`, `ResourceView.title?: string`, `DiscoverResource.title?: string` — consumed by Task 2 (GitHub inbound translator) and Task 5 (presenter).

- [ ] **Step 1: Write the failing contract test**

In `test-next/unit/resources/event-contracts.test.ts`, add `title: 'Improve intake'` to the existing `ResourceDiscovered` sample payload (line ~17-21):

```ts
  [
    ResourceEventType.ResourceDiscovered,
    {
      kind: 'pull-request',
      externalKey: { adapter: 'github', key: 'wake#1' },
      capabilities: [resourceCapability('commentable'), resourceCapability('reviewable')],
      revision: 'abc',
      title: 'Improve intake',
    },
  ],
```

Also add a new test proving old events without `title` still decode (backward compatibility):

```ts
  it('still decodes a ResourceDiscovered event recorded before title existed', () => {
    expect(() =>
      decodeResourceEvent(
        eventEnvelope(
          ResourceEventType.ResourceDiscovered,
          {
            kind: 'issue',
            externalKey: { adapter: 'github', key: 'wake#2' },
            capabilities: [resourceCapability('commentable')],
          },
          stream,
        ),
      ),
    ).not.toThrow();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test-next/unit/resources/event-contracts.test.ts`
Expected: FAIL — zod's `.strict()` object rejects the unknown `title` key.

- [ ] **Step 3: Add `title` to the payload type and schema**

In `src-next/resources/contracts/events.ts`:

```ts
export interface ResourceDiscoveredPayload {
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string | undefined;
  readonly title?: string | undefined;
}
```

And in the zod schema (the `ResourceDiscovered` branch of the discriminated union):

```ts
    payload: z
      .object({
        kind: brandedStringSchema(resourceKind),
        externalKey: z.object({ adapter: z.string(), key: z.string() }).strict(),
        capabilities: z.array(brandedStringSchema(resourceCapability)),
        revision: z.string().optional(),
        title: z.string().optional(),
      })
      .strict(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test-next/unit/resources/event-contracts.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing service-level test**

In `test-next/unit/resources/correlation.test.ts`, add a new test after `'discovers any provider resource behind an opaque adapter key'`:

```ts
  it('retains an optional title captured at discovery', async () => {
    const service = createTestResourceServices(new InMemoryEventJournal(new FakeClock())).resources;

    await service.discover(
      {
        resourceId: resId('titled'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'fake', key: 'repo/issues/9' },
        capabilities: [resourceCapability('commentable')],
        title: 'Fix flaky checkout test',
      },
      context('command-1'),
    );

    await expect(service.get(resId('titled'))).resolves.toMatchObject({
      title: 'Fix flaky checkout test',
    });
  });
```

(Add `import { FakeClock } from '../../e2e/support/world.js';` and `import { InMemoryEventJournal } from '../../../src-next/persistence/index.js';` if not already imported — both are already imported in this file.)

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run test-next/unit/resources/correlation.test.ts`
Expected: FAIL — `title` is not threaded through `discoverResource`/`foldResource`/`resourceProjection`, so `service.get` returns a view without it (TypeScript will also reject passing `title` in the command until Step 3 above plus Step 7 below land).

- [ ] **Step 7: Thread `title` through commands, domain fold, and the projection**

`src-next/resources/contracts/commands.ts`:

```ts
export interface DiscoverResource {
  readonly resourceId: ResourceId;
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
  readonly title?: string;
}
```

`src-next/resources/contracts/views.ts` — add to `ResourceView`:

```ts
export interface ResourceView {
  readonly resourceId: ResourceId;
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string;
  readonly title?: string;
  readonly primaryCorrelationConflict?: {
    readonly attemptedWorkItemId: WorkItemId;
    readonly existingWorkItemId: WorkItemId;
    readonly eventId: string;
  };
}
```

Also add the link-resolver type to the same file (used by Task 3/5):

```ts
export type ResourceLinkResolver = (externalKey: ExternalResourceKey) => string | null;
```

`src-next/resources/domain/resource.ts` — `discoveredResource`:

```ts
function discoveredResource(
  event: Extract<ResourceEvent, { eventType: typeof ResourceEventType.ResourceDiscovered }>,
): ResourceView {
  const revision = event.payload.revision === undefined ? {} : { revision: event.payload.revision };
  const title = event.payload.title === undefined ? {} : { title: event.payload.title };
  return {
    resourceId: event.stream.id,
    kind: event.payload.kind,
    externalKey: event.payload.externalKey,
    capabilities: event.payload.capabilities,
    ...revision,
    ...title,
  };
}
```

`src-next/resources/application/resource-projections.ts` — `ResourceDiscovered` case:

```ts
      case ResourceEventType.ResourceDiscovered:
        return {
          resourceId: owned.stream.id,
          kind: owned.payload.kind,
          externalKey: owned.payload.externalKey,
          capabilities: owned.payload.capabilities,
          ...(owned.payload.revision === undefined ? {} : { revision: owned.payload.revision }),
          ...(owned.payload.title === undefined ? {} : { title: owned.payload.title }),
        };
```

`src-next/resources/application/resource-service.ts` — `discoverResource`:

```ts
async function discoverResource(
  repository: ResourceRepository,
  command: DiscoverResource,
  context: CommandContext,
): Promise<ResourceView> {
  await appendResourceEvent(
    repository,
    command.resourceId,
    resourceDraft(command.resourceId, context, ResourceEventType.ResourceDiscovered, {
      kind: command.kind,
      externalKey: command.externalKey,
      capabilities: command.capabilities,
      ...(command.revision === undefined ? {} : { revision: command.revision }),
      ...(command.title === undefined ? {} : { title: command.title }),
    }),
  );
  const resource = (await repository.load(command.resourceId)).resource;
  if (resource === null) throw new Error(`Resource ${command.resourceId} was not discovered`);
  return resource.view;
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npx vitest run test-next/unit/resources/event-contracts.test.ts test-next/unit/resources/correlation.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full resources unit suite and architecture lint**

Run: `npx vitest run test-next/unit/resources`
Run: `npm run lint:contracts`
Run: `npm run lint:architecture`
Expected: all pass — no new architecture violations (only files inside `resources/` changed).

- [ ] **Step 10: Commit**

```bash
git add src-next/resources test-next/unit/resources
git commit -m "feat(next): add optional title to Resource domain"
```

---

### Task 2: Capture the GitHub issue/PR title at discovery time

**Files:**
- Modify: `src-next/integrations/application/work-admission.ts` (`AdmitObservedWork`, `admitObservedWork`)
- Modify: `src-next/integrations/github/application/inbound-translator.ts` (`apply`)
- Test: `test-next/integration/integrations/inbound-translator.test.ts`

**Interfaces:**
- Consumes: `DiscoverResource.title?: string`, `ResourceService.discover` (Task 1), `ResourceView.title?: string`.
- Produces: newly-discovered GitHub resources carry `title` from `ExternalWorkObservedPayload.title`; re-discovered resources (revision bump on an existing resource) preserve their already-recorded `title` rather than dropping it.

- [ ] **Step 1: Write the failing test**

In `test-next/integration/integrations/inbound-translator.test.ts`, add a new test:

```ts
  it('captures the observed title on the discovered resource', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryEventJournal(clock);
    const { resources, lookup } = createTestResourceServices(journal);
    const work = createWorkService(journal);
    const checkpoints = new InMemoryCheckpointStore();
    const event = createEventDraft({
      eventId: 'github:delivery-8',
      eventType: 'integration.github.work-observed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'github:delivery-8',
      causationId: 'github:delivery-8',
      actor: { kind: 'integration', id: 'github' },
      source: { kind: 'adapter', id: 'github' },
      stream: integrationStream(BuiltInAdapterId.GitHub),
      payload: observation(),
    });
    await journal.append(event.stream, 0, [event]);
    const { orchestration, routing } = createTestIntakeRouting(journal, work);
    const translator = new InboundTranslator(journal, checkpoints, work, resources, {
      lookup,
      orchestration,
      routing,
    });

    await translator.runOnce();

    const resourceId = await lookup.resourceIdForExternalKey({ adapter: 'github', key: 'owner/repo#7' });
    await expect(resources.get(resourceId!)).resolves.toMatchObject({ title: 'Improve intake' });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test-next/integration/integrations/inbound-translator.test.ts`
Expected: FAIL — `resources.get(...)` resolves without a `title` field.

- [ ] **Step 3: Thread `title` through `AdmitObservedWork` and both `discover` call sites**

`src-next/integrations/application/work-admission.ts`:

```ts
export interface AdmitObservedWork {
  readonly adapter: AdapterId;
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly kind: ResourceKind;
  readonly externalKey: { readonly adapter: AdapterId; readonly key: string };
  readonly capabilities: readonly ResourceCapability[];
  readonly objective: string;
  readonly tags: readonly string[];
  readonly revision?: string | undefined;
  readonly title?: string | undefined;
}

export async function admitObservedWork(
  services: WorkAdmissionServices,
  input: AdmitObservedWork,
  context: CommandContext,
  beforeStart?: () => Promise<void>,
): Promise<void> {
  await services.resources.discover(
    {
      resourceId: input.resourceId,
      kind: input.kind,
      externalKey: input.externalKey,
      capabilities: input.capabilities,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      ...(input.title === undefined ? {} : { title: input.title }),
    },
    context,
  );
  // ...unchanged below
```

`src-next/integrations/github/application/inbound-translator.ts` — pass `title` into the `admitObservedWork` call (line ~188-207), and preserve the already-recorded title on the re-discovery branch (line ~168-177) instead of dropping it:

```ts
      if (current.revision !== payload.revision) {
        await this.resources.discover(
          {
            resourceId: current.resourceId,
            kind: current.kind,
            externalKey: current.externalKey,
            capabilities: current.capabilities,
            revision: payload.revision,
            ...(current.title === undefined ? {} : { title: current.title }),
          },
          context,
        );
      }
```

```ts
    await admitObservedWork(
      this.admissionServices(),
      {
        adapter: this.adapter,
        resourceId: resourceIdValue,
        workItemId: workItemIdValue,
        kind: isPullRequest ? BuiltInResourceKind.PullRequest : BuiltInResourceKind.Issue,
        externalKey: { adapter: this.adapter, key: payload.externalKey },
        capabilities: isPullRequest
          ? [
              BuiltInResourceCapability.Commentable,
              BuiltInResourceCapability.Reviewable,
              BuiltInResourceCapability.Revisioned,
            ]
          : [BuiltInResourceCapability.Commentable],
        objective: payload.title,
        tags: intake.tags,
        revision: payload.revision,
        title: payload.title,
      },
      context,
      // ...unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test-next/integration/integrations/inbound-translator.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full integrations suite**

Run: `npx vitest run test-next/integration/integrations test-next/unit/integrations`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-next/integrations/application/work-admission.ts src-next/integrations/github/application/inbound-translator.ts test-next/integration/integrations/inbound-translator.test.ts
git commit -m "feat(next): capture GitHub issue/PR title on resource discovery"
```

---

### Task 3: Add a GitHub resource link resolver

**Files:**
- Create: `src-next/integrations/github/application/resource-links.ts`
- Modify: `src-next/integrations/github/index.ts` (barrel export)
- Test: `test-next/unit/integrations/github-resource-links.test.ts`

**Interfaces:**
- Consumes: `ExternalResourceKey` (from `resources/index.ts`, already a permitted `integrations` dependency).
- Produces: `resolveGitHubResourceUrl: ResourceLinkResolver` (matches `ResourceLinkResolver` from Task 1), exported from `integrations/github/index.ts` for Task 4 (composition-root) to consume through the public barrel.

- [ ] **Step 1: Write the failing test**

Create `test-next/unit/integrations/github-resource-links.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveGitHubResourceUrl } from '../../../src-next/integrations/github/application/resource-links.js';

describe('resolveGitHubResourceUrl', () => {
  it('builds an issue/PR URL from an owner/repo#number external key', () => {
    // GitHub redirects /issues/<n> to /pull/<n> automatically when <n> is a PR,
    // so one path form covers both kinds without the resolver needing ResourceKind.
    expect(resolveGitHubResourceUrl({ adapter: 'github', key: 'atolis-hq/wake#412' })).toBe(
      'https://github.com/atolis-hq/wake/issues/412',
    );
  });

  it('returns null for a key it cannot parse', () => {
    expect(resolveGitHubResourceUrl({ adapter: 'github', key: 'not-a-locator' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test-next/unit/integrations/github-resource-links.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the resolver**

Create `src-next/integrations/github/application/resource-links.ts`:

```ts
import type { ExternalResourceKey, ResourceLinkResolver } from '../../../resources/index.js';

const issueOrPullRequestLocator = /^(?<owner>[^/]+)\/(?<repo>[^#]+)#(?<number>[1-9]\d*)$/;

export const resolveGitHubResourceUrl: ResourceLinkResolver = (
  externalKey: ExternalResourceKey,
): string | null => {
  const match = issueOrPullRequestLocator.exec(externalKey.key);
  if (match?.groups === undefined) return null;
  const { owner, repo, number } = match.groups;
  return `https://github.com/${owner}/${repo}/issues/${number}`;
};
```

- [ ] **Step 4: Export it from the GitHub barrel**

In `src-next/integrations/github/index.ts`, add (alphabetically among the `application/*` exports):

```ts
export * from './application/resource-links.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test-next/unit/integrations/github-resource-links.test.ts`
Expected: PASS

- [ ] **Step 6: Run architecture lint**

Run: `npm run lint:architecture`
Expected: PASS — the resolver only imports from `resources/index.ts`, an already-permitted dependency for `integrations`.

- [ ] **Step 7: Commit**

```bash
git add src-next/integrations/github/application/resource-links.ts src-next/integrations/github/index.ts test-next/unit/integrations/github-resource-links.test.ts
git commit -m "feat(next): add GitHub resource link resolver"
```

---

### Task 4: Wire the link resolver into the composition root

**Files:**
- Modify: `src-next/bootstrap/composition-root.ts`

**Interfaces:**
- Consumes: `resolveGitHubResourceUrl` (Task 3), `ResourceLinkResolver`, `ExternalResourceKey` (Task 1).
- Produces: `CompositionRoot.resolveResourceLink: ResourceLinkResolver` — consumed by Task 5's presenter call sites via `root.resolveResourceLink`.

- [ ] **Step 1: Add the resolver registry and expose it on `CompositionRoot`**

In `src-next/bootstrap/composition-root.ts`, import the resolver alongside the existing GitHub barrel import:

```ts
import { gitHubProviderDefinition, resolveGitHubResourceUrl } from '../integrations/github/index.js';
```

Add the type import:

```ts
import { createResourceLookup, createResourceService, resourceId } from '../resources/index.js';
import type { ResourceLinkResolver } from '../resources/index.js';
```

Add a small adapter-keyed registry and a resolver function near the top-level helpers (after `createWorkflowRouter`, same file):

```ts
const resourceLinkResolvers: Record<string, ResourceLinkResolver> = {
  github: resolveGitHubResourceUrl,
};

function resolveResourceLink(externalKey: { readonly adapter: string; readonly key: string }): string | null {
  return resourceLinkResolvers[externalKey.adapter]?.(externalKey) ?? null;
}
```

Add the field to the `CompositionRoot` interface:

```ts
export interface CompositionRoot {
  // ...existing fields
  readonly resolveResourceLink: ResourceLinkResolver;
}
```

Add it to the object returned from `createCompositionRoot` (in the final `return { ... }`):

```ts
  return {
    config,
    fakeScenarios,
    paths,
    journal,
    projections,
    checkpoints,
    activities,
    work,
    resources,
    lookup,
    orchestration,
    execution,
    runnerControls,
    advanceOnce,
    resolveResourceLink,
    ...runtime,
  };
```

- [ ] **Step 2: Run the build to verify it type-checks**

Run: `npm run build`
Expected: PASS (no test to write here — this task only wires an existing, already-tested function into the composition root; Task 5 will exercise it through the presenter).

- [ ] **Step 3: Run architecture lint**

Run: `npm run lint:architecture`
Expected: PASS — `composition-root.ts` imports `resolveGitHubResourceUrl` from the GitHub barrel (`index.ts`), satisfying `compositionRootBarrelRule`.

- [ ] **Step 4: Commit**

```bash
git add src-next/bootstrap/composition-root.ts
git commit -m "feat(next): wire the GitHub resource link resolver into the composition root"
```

---

### Task 5: Extend the API contract and presenter with link/title/adapter

**Files:**
- Modify: `src-next/surfaces/api/contracts/resources.ts` (`ResourceItemResponse`)
- Modify: `src-next/surfaces/api/presenters/resources.ts` (`presentResource`)
- Modify: `src-next/bootstrap/surface-api-work-applications.ts` (call site, line ~72)
- Modify: `src-next/bootstrap/surface-api-applications.ts` (call site, line ~104)
- Test: `test-next/unit/surfaces/resources-presenter.test.ts` (new)

**Interfaces:**
- Consumes: `ResourceView.title?: string` (Task 1), `CompositionRoot.resolveResourceLink` (Task 4).
- Produces: `ResourceItemResponse` gains `adapter: string`, `locatorLabel: string`, optional `title?: string`, optional `externalUrl?: string`. `presentResource` becomes a curried function: `presentResource(resolveLink: ResourceLinkResolver): (value: ResourceView) => ResourceItemResponse` — Task 6's UI decoder and Task 8's `work.tsx` both consume the new response fields; nothing else calls `presentResource` uncurried after this task.

- [ ] **Step 1: Write the failing presenter test**

Create `test-next/unit/surfaces/resources-presenter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { presentResource } from '../../../src-next/surfaces/api/presenters/resources.js';
import { resourceCapability, resourceKind } from '../../../src-next/resources/index.js';
import { resId } from '../../support/identities.js';

const noLink = () => null;
const githubLink = () => 'https://github.com/atolis-hq/wake/issues/412';

describe('presentResource', () => {
  it('uses the resolved title when present, and includes the external link when the resolver matches', () => {
    const present = presentResource(githubLink);
    expect(
      present({
        resourceId: resId('one'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake#412' },
        capabilities: [resourceCapability('commentable')],
        title: 'Fix flaky checkout test',
      }),
    ).toEqual({
      resourceId: resId('one'),
      adapter: 'github',
      kind: resourceKind('issue'),
      title: 'Fix flaky checkout test',
      locatorLabel: 'issue atolis-hq/wake#412',
      externalUrl: 'https://github.com/atolis-hq/wake/issues/412',
      capabilities: [resourceCapability('commentable')],
    });
  });

  it('falls back to a locator label and omits externalUrl when no resolver matches', () => {
    const present = presentResource(noLink);
    expect(
      present({
        resourceId: resId('two'),
        kind: resourceKind('document'),
        externalKey: { adapter: 'unknown-adapter', key: 'design-notes.md' },
        capabilities: [],
      }),
    ).toEqual({
      resourceId: resId('two'),
      adapter: 'unknown-adapter',
      kind: resourceKind('document'),
      locatorLabel: 'document design-notes.md',
      capabilities: [],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test-next/unit/surfaces/resources-presenter.test.ts`
Expected: FAIL — `presentResource` is not a curried function and the response shape doesn't match.

- [ ] **Step 3: Update the API contract**

`src-next/surfaces/api/contracts/resources.ts`:

```ts
export interface ResourceItemResponse {
  readonly resourceId: string;
  readonly adapter: string;
  readonly kind: string;
  readonly locatorLabel: string;
  readonly title?: string;
  readonly externalUrl?: string;
  readonly capabilities: readonly string[];
  readonly revision?: string;
}
```

- [ ] **Step 4: Update the presenter**

`src-next/surfaces/api/presenters/resources.ts`:

```ts
import type { ResourceLinkResolver, ResourceView } from '../../../resources/index.js';
import type { ResourceItemResponse } from '../contracts/resources.js';

export function presentResource(
  resolveLink: ResourceLinkResolver,
): (value: ResourceView) => ResourceItemResponse {
  return (value) => {
    const externalUrl = resolveLink(value.externalKey);
    return {
      resourceId: value.resourceId,
      adapter: value.externalKey.adapter,
      kind: value.kind,
      locatorLabel: `${value.kind} ${value.externalKey.key}`,
      capabilities: value.capabilities,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(externalUrl === null ? {} : { externalUrl }),
      ...(value.revision === undefined ? {} : { revision: value.revision }),
    };
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test-next/unit/surfaces/resources-presenter.test.ts`
Expected: PASS

- [ ] **Step 6: Fix the two call sites (this will currently fail to build)**

`src-next/bootstrap/surface-api-work-applications.ts` line ~72:

```ts
    resources: resources.map(presentResource(root.resolveResourceLink)),
```

`src-next/bootstrap/surface-api-applications.ts` — `createResourceApplications`:

```ts
function createResourceApplications(root: CompositionRoot, now: () => string) {
  return {
    async list(query: Parameters<ApiApplications['resources']['list']>[0]) {
      const stored = (await root.projections.list<ResourceView | null>('resources')).flatMap(
        (entry) => (entry.value === null ? [] : [{ ...entry, value: entry.value }]),
      );
      return projectionPage(root.journal, stored, query, presentResource(root.resolveResourceLink), {
        emptyAsOf: now(),
      });
    },
  };
}
```

- [ ] **Step 7: Run the build and full surfaces/bootstrap suites**

Run: `npm run build`
Run: `npx vitest run test-next/unit/surfaces test-next/integration/surfaces`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src-next/surfaces/api src-next/bootstrap/surface-api-work-applications.ts src-next/bootstrap/surface-api-applications.ts test-next/unit/surfaces/resources-presenter.test.ts
git commit -m "feat(next): resolve resource links and titles in the API presenter"
```

---

### Task 6: Update the browser-side response decoder

**Files:**
- Modify: `src-next/surfaces/web/src/api/decoders.ts` (`decodeResourceItem`)

**Interfaces:**
- Consumes: `ResourceItemResponse` (Task 5).
- Produces: `decodeResourceItem` now validates and passes through `adapter`, `locatorLabel`, optional `title`, optional `externalUrl` — consumed by Task 8's `work.tsx`.

- [ ] **Step 1: Update the decoder**

`src-next/surfaces/web/src/api/decoders.ts`:

```ts
export const decodeResourceItem: Decoder<ResourceItemResponse> = (value, path = '') => {
  const record = object(value, path);
  return {
    resourceId: string(record.resourceId, child(path, 'resourceId')),
    adapter: string(record.adapter, child(path, 'adapter')),
    kind: string(record.kind, child(path, 'kind')),
    locatorLabel: string(record.locatorLabel, child(path, 'locatorLabel')),
    capabilities: array(record.capabilities, child(path, 'capabilities'), string),
    ...optionalStringProperty(record, 'title', path),
    ...optionalStringProperty(record, 'externalUrl', path),
    ...optionalStringProperty(record, 'revision', path),
  };
};
```

- [ ] **Step 2: Run the build to verify it type-checks**

Run: `npm run build`
Expected: PASS. (This decoder has no dedicated unit test today — it's exercised end-to-end through `work-detail.test.tsx`, updated in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src-next/surfaces/web/src/api/decoders.ts
git commit -m "feat(next): decode resource link/title fields in the web client"
```

---

### Task 7: Add hand-rolled resource icon components

**Files:**
- Create: `src-next/surfaces/web/src/components/resource-icons.tsx`

**Interfaces:**
- Produces: `GitHubIcon`, `DocumentIcon`, `ExternalLinkIcon` — each `(props: { readonly className?: string }) => JSX.Element` — consumed by Task 8's `work.tsx`.

- [ ] **Step 1: Write the component (no separate test — covered by Task 8's rendering test)**

Create `src-next/surfaces/web/src/components/resource-icons.tsx`:

```tsx
interface IconProps {
  readonly className?: string;
}

export function GitHubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.44-2.44-.97-2.44-.97-.33-.84-.81-1.06-.81-1.06-.66-.45.05-.44.05-.44.73.05 1.12.75 1.12.75.65 1.11 1.71.79 2.13.6.07-.48.26-.79.46-.98-1.6-.18-3.29-.8-3.29-3.57 0-.79.28-1.43.75-1.94-.08-.18-.32-.92.07-1.92 0 0 .61-.2 2 .74a6.9 6.9 0 0 1 3.65 0c1.39-.94 2-.74 2-.74.39 1 .15 1.74.07 1.92.47.51.75 1.15.75 1.94 0 2.78-1.69 3.39-3.3 3.57.27.23.5.68.5 1.38l-.01 2.04c0 .21.14.45.55.38A8 8 0 0 0 8 0z" />
    </svg>
  );
}

export function DocumentIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9.5 1.1 13 4.6V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h5.5v.1ZM9 2H4v12h8V5H9V2Z" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" className={className} aria-hidden="true">
      <path d="M10.75 1a.75.75 0 0 0 0 1.5h1.94L6.22 9.03a.75.75 0 1 0 1.06 1.06l6.47-6.47v1.94a.75.75 0 0 0 1.5 0V1h-4.5Z" />
      <path d="M3.5 3A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9a.75.75 0 0 0-1.5 0v3.5h-8v-8H7A.75.75 0 0 0 7 3H3.5Z" />
    </svg>
  );
}
```

- [ ] **Step 2: Run the build to verify it type-checks**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-next/surfaces/web/src/components/resource-icons.tsx
git commit -m "feat(next): add hand-rolled resource icon components"
```

---

### Task 8: Render resources as clickable cards in the work item modal

**Files:**
- Modify: `src-next/surfaces/web/src/features/work/work.tsx` (Resources section, lines ~145-167)
- Modify: `src-next/surfaces/web/src/features/features.module.css` (`.resourceList`/`.resourceId` rules, lines ~187-205)
- Modify: `src-next/surfaces/web/test/work-detail.test.tsx` (resource fixture + assertions)

**Interfaces:**
- Consumes: `ResourceItemResponse` fields from Task 5/6, `GitHubIcon`/`DocumentIcon`/`ExternalLinkIcon` from Task 7.

- [ ] **Step 1: Update the failing/changed test fixtures first**

In `src-next/surfaces/web/test/work-detail.test.tsx`, replace the `resources` array in the mock response (line ~38-45) with:

```ts
              resources: [
                {
                  resourceId: 'resource-1',
                  adapter: 'unknown-adapter',
                  kind: 'unheard-of-kind',
                  locatorLabel: 'unheard-of-kind resource-1',
                  capabilities: ['inspect', 'annotate'],
                  revision: 'rev-9',
                },
              ],
```

Update the `'renders an unknown resource kind generically'` test (line ~102-113) to also prove the fallback icon renders and no link is present:

```ts
  it('renders an unknown resource kind generically, proving no kind-specific branch', async () => {
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={detailClient()} />
      </MemoryRouter>,
    );
    const resources = await screen.findByRole('list', { name: 'Resources' });
    expect(resources.textContent).toContain('unheard-of-kind resource-1');
    expect(resources.textContent).toContain('inspect');
    expect(resources.textContent).toContain('annotate');
    expect(screen.queryByRole('link', { name: /unheard-of-kind/ })).toBeNull();
  });

  it('links a resource with a title and resolved external URL', async () => {
    const work = {
      workItemKey: 'wk_a',
      workItemId: 'work-a',
      objective: 'Alpha',
      state: 'open',
      relatedWorkItems: [],
    };
    const client = new WakeApiClient(async (input) => {
      const url = String(input);
      const body = url.includes('/events')
        ? { items: [], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
        : url.includes('/work-items/wk_a')
          ? {
              data: {
                work,
                resources: [
                  {
                    resourceId: 'resource-1',
                    adapter: 'github',
                    kind: 'issue',
                    locatorLabel: 'issue owner/repo#412',
                    title: 'Fix flaky checkout test',
                    externalUrl: 'https://github.com/owner/repo/issues/412',
                    capabilities: ['commentable'],
                  },
                ],
                orchestration: { primary: null, children: [] },
                execution: { runs: [] },
                activities: {},
              },
              meta: { asOf },
            }
          : url.includes('/work-items')
            ? { items: [work], page: { nextCursor: null, hasMore: false }, meta: { asOf } }
            : { data: { paused: false, updatedAt: asOf }, meta: { asOf } };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    render(
      <MemoryRouter initialEntries={['/work/wk_a']}>
        <App client={client} />
      </MemoryRouter>,
    );
    const link = await screen.findByRole('link', { name: /Fix flaky checkout test/ });
    expect(link.getAttribute('href')).toBe('https://github.com/owner/repo/issues/412');
    expect(link.textContent).toContain('issue owner/repo#412');
  });
```

(`WakeApiClient` is already imported at the top of this file. This test builds its own fetch mock inline, following the exact same shape as `detailClient()` above, rather than reusing it, since `WakeApiClient`'s constructor takes a plain `fetchImplementation` function rather than exposing a callable `.fetch` method.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src-next/surfaces/web/test/work-detail.test.tsx`
Expected: FAIL — current markup still renders the raw `resourceId` and has no `<a>`.

- [ ] **Step 3: Update the CSS**

In `src-next/surfaces/web/src/features/features.module.css`, replace the `.resourceList`/`.resourceId` block (lines ~187-205) with:

```css
.resourceList {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.resourceCard {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  color: inherit;
  text-decoration: none;
}
a.resourceCard:hover {
  border-color: var(--border-strong);
}
.resourceCardTop {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.resourceCardIcon {
  flex: 0 0 auto;
  color: var(--ink-muted);
}
.resourceCardTitle {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resourceCardExt {
  flex: 0 0 auto;
  color: var(--ink-muted);
  opacity: 0;
}
.resourceCard:hover .resourceCardExt {
  opacity: 1;
}
.resourceCardMeta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.4rem;
  font-size: var(--text-sm);
  padding-left: calc(18px + var(--space-2));
}
.resourceId {
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Update `work.tsx`**

Add the icon imports near the existing component imports:

```ts
import { DocumentIcon, ExternalLinkIcon, GitHubIcon } from '../../components/resource-icons.js';
```

Add a small adapter-to-icon lookup above the component (or inline near the section — place it as a module-level constant next to other module-level helpers in this file):

```ts
const resourceIcons: Record<string, typeof GitHubIcon> = {
  github: GitHubIcon,
};
```

Replace the Resources section (lines ~145-167) with:

```tsx
<section aria-labelledby="work-resources">
  <h2 id="work-resources">Resources</h2>
  {query.data.data.resources.length === 0 ? (
    <EmptyState>No correlated resources</EmptyState>
  ) : (
    <ul className={styles.resourceList} aria-label="Resources">
      {query.data.data.resources.map((resource) => {
        const Icon = resourceIcons[resource.adapter] ?? DocumentIcon;
        const heading = resource.title ?? resource.locatorLabel;
        const body = (
          <>
            <div className={styles.resourceCardTop}>
              <Icon className={styles.resourceCardIcon} />
              <span className={styles.resourceCardTitle}>{heading}</span>
              {resource.externalUrl !== undefined && (
                <ExternalLinkIcon className={styles.resourceCardExt} />
              )}
            </div>
            <div className={styles.resourceCardMeta}>
              {resource.title !== undefined && (
                <span className={styles.resourceId}>{resource.locatorLabel}</span>
              )}
              {resource.capabilities.map((capability) => (
                <Chip key={capability} variant="outline">
                  {capability}
                </Chip>
              ))}
              {resource.revision !== undefined && (
                <span className={styles.resourceId}>{resource.revision}</span>
              )}
            </div>
          </>
        );
        return (
          <li key={resource.resourceId}>
            {resource.externalUrl !== undefined ? (
              <a
                className={styles.resourceCard}
                href={resource.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {body}
              </a>
            ) : (
              <div className={styles.resourceCard}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  )}
</section>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src-next/surfaces/web/test/work-detail.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the full web test suite and build**

Run: `npx vitest run src-next/surfaces/web`
Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-next/surfaces/web/src/features/work/work.tsx src-next/surfaces/web/src/features/features.module.css src-next/surfaces/web/test/work-detail.test.tsx
git commit -m "feat(next): render resources as clickable cards with icons and links"
```

---

### Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full target-architecture verification suite**

Run: `npm run lint:contracts`
Run: `npm run lint:architecture`
Run: `npm run knip:next`
Run: `npm run verify:next`
Expected: all PASS.

- [ ] **Step 2: Run the legacy-compatible full verify (still required until Task 28's gate)**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 3: Manually confirm in a browser**

Start the app per this repo's `run` skill/dev script, open a work item with at least one GitHub-sourced resource, and confirm: the card shows the GitHub icon, the issue/PR title, a locator subtitle, capability chips, an external-link icon that appears on hover, and clicking the card opens the resource on github.com in a new tab. Confirm a resource from an unrecognized adapter renders the generic document icon and is not clickable.

- [ ] **Step 4: Commit** (only if any fixes were needed during verification)

```bash
git add -A
git commit -m "fix(next): address verification findings for resource card links"
```
