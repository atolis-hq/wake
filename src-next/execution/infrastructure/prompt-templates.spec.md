# Prompt templates and transcripts — Component Specification

## Type, purpose, and scope

Adapter. This component renders a named wake-root prompt template into the
prompt text a runner receives, and provides a write-only helper for
persisting prompt/response text per Run. It is a translation boundary
between the filesystem (`prompts/*.md`) and the plain string a runner
invocation needs.

## Responsibilities and boundaries

This component owns loading a template file, validating its YAML
frontmatter, and rendering its Handlebars body against a supplied context.
It also owns writing a transcript file for a given Run. It does not decide
which template an invocation should use, does not build the runner request
from the rendered output (the agent Activity handler does that), and does
not itself invoke a runner.

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

- Writing a transcript MUST create its target directory if it does not
  already exist, and MUST write to a filename derived from the Run id with
  every character outside `[a-zA-Z0-9._-]` replaced by a hyphen, suffixed
  by `.prompt.txt` or `.response.txt` depending on which kind is written.
- Writing a transcript MUST overwrite any existing file at that path; there
  is no append or versioning behaviour.

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
  file and writing a transcript file.
- Bootstrap (depends on) — the only current caller of `loadPromptTemplate`
  and `renderPromptTemplate`, wiring them into the built-in agent Activity's
  template renderer; it plucks `model`, `allowedTools`, and `maxTurns` from
  the validated frontmatter to build the renderer's return value.
- Wake home's `prompts/` directory convention (depends on) — every template
  is resolved as `{wakeRoot}/prompts/{name}.md`.

## Decisions, exclusions, and deferred capability

- Transcript persistence exists as infrastructure but is not invoked from
  the production attempt flow; nothing in Bootstrap's wiring calls
  `writeTranscript`. See the module specification's own deferred-capability
  note.
- There is no template cache; every call to load a template re-reads and
  re-parses the file from disk.
- There is no reader counterpart to `writeTranscript` in this component.
