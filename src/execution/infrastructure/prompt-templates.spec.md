# Prompt templates and transcripts — Component Specification

## Type, purpose, and scope

Adapter. This component renders a named wake-root prompt template into the
prompt text a runner receives. Its adjacent transcript store persists opt-in,
filesystem-only raw prompt/response artifacts as safe run or session groups
per WorkItem. Together they are the translation boundary between the
filesystem (`prompts/*.md` and `.wake/transcripts/`) and the plain strings a
runner invocation and transcript reader need.

## Responsibilities and boundaries

This component owns loading a template file, validating its YAML
frontmatter, and rendering its Handlebars body against a supplied context.
The transcript store owns capture, grouping, reading, and retention of raw
text. Neither chooses a template, builds the runner request from rendered
output (the agent Activity handler does that), nor invokes a runner.

## Core policies, invariants, and behaviours

**Loading and rendering**

- A template name MUST match `^[a-z0-9][a-z0-9-]*$` (case-insensitive)
  before the filesystem is touched; any other name MUST be rejected with an
  error rather than resolved into a path.
- A template file MUST begin with a YAML frontmatter block delimited by
  `---` lines; a file that does not match this shape MUST be rejected —
  frontmatter is mandatory even though every field within it is optional.
- The frontmatter MUST validate against a strict schema: an unrecognized
  frontmatter key MUST be rejected, not silently ignored. A YAML syntax
  error, or a schema validation failure, MUST be rejected with an error
  that names the underlying cause.
- Frontmatter MAY declare `model`, `maxTurns`, `allowedTools`, and
  `extraArgs`; only `maxTurns` is non-nullable when present (an explicit
  `null` is accepted for the others as an explicit "no value").
- Rendering MUST compile the template body as Handlebars with HTML
  auto-escaping disabled, so interpolated context values appear verbatim in
  the rendered prompt rather than escaped as if for HTML output.
- Rendering MUST fail when the template body references a context field the
  caller did not supply, rather than silently rendering an empty value in
  its place.

**Transcripts**

- With capture enabled, the agent Activity MUST store the exact runner prompt
  before invoking the runner and its raw response after the runner settles.
  This data is filesystem-only: it MUST NOT be placed in events, projections,
  or journal records.
- A prompt is staged by safe WorkItem/run path. A response moves it to a safe
  run group when no session ID is returned, or to a safe session group keyed
  by CLI identity plus an opaque session identifier; the raw session ID is not
  used as a filesystem path segment.
- Group readers return timestamp-ordered prompt/response messages and group
  metadata. Bootstrap presents them as CLI-neutral `input` and `agent`
  conversation entries for the API and web UI.
- Only when pre-dispatch workspace recovery reclaims an owned workspace for a
  closed WorkItem, a zero retention period deletes its transcript directory
  immediately; otherwise a filesystem cleanup marker is swept after the
  configured retention period. Failures are operational diagnostics, are
  retried by later unpaused control-plane ticks, and do not affect the run or
  workspace outcome.

## Conceptual schema

**PromptTemplate**

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | The validated template name. |
| `body` | string | The trimmed template body, after the frontmatter block. |
| `frontmatter.model` | string, optional/nullable | Overrides the runner's default model when rendered. |
| `frontmatter.maxTurns` | positive integer, optional | Carried through to the agent Activity's runner request when present. |
| `frontmatter.allowedTools` | list of string, optional/nullable | Overrides the runner's default allowed tools when rendered. |
| `frontmatter.extraArgs` | list of string, optional/nullable | Validated by the schema; no current caller reads this field from a loaded template. |

## Dependencies and system role

- Handlebars, and the `yaml` parsing library — the templating and
  frontmatter-parsing engines this adapter wraps.
- `node:fs/promises` — the external effect boundary for reading a template
  file and storing, grouping, reading, marking, and sweeping transcript
  files.
- Bootstrap (depends on) — the only current caller of `loadPromptTemplate`
  and `renderPromptTemplate`, wiring them into the built-in agent Activity's
  template renderer; it plucks `model`, `allowedTools`, and `maxTurns` from
  the validated frontmatter to build the renderer's return value.
- Wake home's `prompts/` directory convention (depends on) — every template
  is resolved as `{wakeRoot}/prompts/{name}.md`.

## Decisions, exclusions, and deferred capability

- Transcript capture is enabled only by the strict root `transcripts`
  configuration and Bootstrap composes no transcript store when it is off.
- There is no template cache; every call to load a template re-reads and
  re-parses the file from disk.
- Transcript artifact access is mediated by Bootstrap applications; neither
  templates nor the store expose transcript contents as journal state.
