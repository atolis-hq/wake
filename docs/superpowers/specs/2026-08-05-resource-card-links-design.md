# Resource card links — design

Date: 2026-08-05

## Problem

The work item modal's "Resources" section (`src-next/surfaces/web/src/features/work/work.tsx`) shows each correlated resource as a plain `<li>` with its internal `resourceId` (a Wake-minted ULID, meaningless to a human), a `kind` chip, and capability chips. There is no external link and no title — legacy `src/` showed a role badge plus a clickable link built by parsing an opaque `resourceUri` string client-side.

`src-next`'s domain model already splits resource identity more cleanly into `kind` (provider-neutral) and `externalKey: { adapter, key }` (provider-specific locator), but the API presenter drops `externalKey` before it reaches the browser, so there's currently no way to build a link, show a title, or pick a provider icon.

## Goals

- Show a GitHub issue/PR resource with its title and a clickable link out to GitHub, in a generic (non-GitHub-specific) way that any future adapter can plug into.
- Show a recognizable icon per adapter (GitHub logo for `github`, generic document icon as the fallback for anything unrecognized).
- Keep URL-building and title capture out of the UI and out of the `resources` domain module's "provider payload/translation" boundary — each integration adapter owns its own locator format.
- Redesign the resource row as a card: hover state, external-link icon that appears on hover, whole card clickable when a link is available.

## Non-goals

- Keeping the title in sync with upstream renames (captured once at discovery; may go stale — acceptable, cosmetic).
- Per-kind icon variation within an adapter (e.g. different icons for GitHub issue vs PR) — icon is keyed by `adapter` only.
- Any change to the `role`/`relation` correlation semantics beyond continuing to surface `primary`/`secondary` as a chip.

## Design

### Domain model (`resources` module)

Add an optional `title?: string` to `ResourceDiscoveredPayload` and to `ResourceView` (`src-next/resources/contracts/events.ts`, `src-next/resources/contracts/views.ts`), plus the corresponding zod schema field. This is generic resource metadata — a human-readable label — analogous to how `capabilities` already generalizes provider state, not a provider-payload leak. It is set once at discovery and never updated by `ResourceRevisionObserved`.

### GitHub integration

`integrations/github/application/inbound-translator.ts` already has the issue/PR title in hand when it emits `ResourceDiscovered` for other purposes (WorkItem projections) — thread it through as the new `title` field.

Add `resolveResourceUrl(externalKey: ExternalResourceKey): string | null` in `integrations/github`, functionally equivalent to legacy's `resourceUriToUrl` but scoped to this adapter's own locator format (`owner/repo#number`) rather than a central multi-provider parser. Register it in `composition-root.ts` in a small resolver registry keyed by adapter name, the same pattern used for runners/work-sources.

### Presenter (`surfaces/api/presenters/resources.ts`)

Looks up the registered resolver by `externalKey.adapter` and builds:

```ts
interface ResourceItemResponse {
  resourceId: string;
  adapter: string;          // drives icon lookup client-side
  kind: string;
  displayLabel: string;     // title, else "<kind> <locator>" fallback — never the raw resourceId
  externalUrl?: string;     // omitted when no resolver is registered for the adapter, or it returns null
  capabilities: readonly string[];
  revision?: string;
}
```

`externalKey.key` itself is never sent to the browser raw — only the resolved `externalUrl` and the human-readable `displayLabel`, keeping the frontend decoupled from provider-specific locator formats.

### UI (`work.tsx`)

A small `Record<string, IconComponent>` keyed by `adapter` (`github` → GitHub mark; default → generic document icon) selects the resource icon.

Each resource renders as a card:
- Icon (top-left), title, external-link icon (top-right, opacity 0 → 1 on hover)
- Subtitle line: locator-derived text (e.g. `owner/repo · issue #412`) plus capability/correlation chips (`commentable`, `primary`/`secondary`, etc.) inline on the same line
- The whole card is an `<a href={externalUrl}>` when `externalUrl` is present (hover elevates + shadows, matches "artefact you can click out to"); when absent, it renders as a plain non-interactive `<div>` with the same layout — no hover elevation, no ext icon, no dead link.

### Error handling

- No resolver registered for an adapter, or the resolver can't parse the key → `externalUrl` omitted, card renders as inert (still shows icon/title/chips).
- No `title` captured at discovery → `displayLabel` falls back to `"<kind> <locator>"` built from `externalKey.key`, never the raw internal `resourceId`.

### Testing

- `resources` contracts: schema accepts/rejects the new `title` field; existing fixtures without `title` still decode (backward compatible, optional field).
- GitHub presenter/resolver: unit tests for URL construction (issue and PR), and the malformed-key / unknown-adapter → `null` fallback path.
- `work.tsx`: component test/story covering three states — GitHub issue with link, unrecognized-adapter fallback icon (no link), and missing-title fallback label.
