# Agent setup guide (`SETUP.md`) design

## Problem

`wake init` scaffolds a working `config.yaml` / `config.workflows.yaml` /
`prompts/` split, but making it *useful* (pointing it at a real GitHub repo,
picking a real runner, wiring credential mounts) means hand-editing YAML
against the full `docs/configuration.md` reference. That doc is complete but
long, and most users configuring a fresh wake home only need to make three
decisions. A guided CLI wizard would duplicate that reference doc as code and
needs to be maintained in lockstep. Instead, `wake init` should scaffold a
file that an agent (Claude Code, Codex, Cursor — whatever the user already
has open) can read and act on directly, with no install step and no new CLI
surface.

## What gets scaffolded

`wake init` copies a new static file, `SETUP.md`, into the wake home root
alongside `config.yaml`, `config.workflows.yaml`, and `prompts/`. It is copied
verbatim (no templating/interpolation) the same way `prompts/*.md` are copied
today by `copyAssets` in `src/cli/scaffold-assets.ts` — a single new source
file in the wake repo (e.g. `templates/SETUP.md`, mirroring how `prompts/`
already sits at repo root) added to the copy step in `scaffoldWakeHome`.

Static content was chosen over interpolating this wake home's live config
values: it avoids a second templating path that can drift from `config.yaml`,
and the instructions simply tell the agent to read the actual config file for
current values rather than embedding a snapshot that goes stale.

## Audience and voice

`SETUP.md` is written as instructions *to an agent*, not prose for a human to
read start-to-end — e.g. "Read `config.yaml` and `config.workflows.yaml` in
this directory. Ask the user the following, in order, then edit the files
directly." A user's actual interaction is "read SETUP.md and help me
configure this," said to whichever agent CLI they have open in the wake home
directory.

## Scope

Config only. `SETUP.md` covers the three decisions that block a fresh wake
home from doing anything useful. It explicitly does not re-explain
`wake sandbox build`/`up`/`down` — once config looks right, it tells the
agent/user to follow `docs/getting-started.md` for that. This keeps the file
short and avoids a second copy of the sandbox lifecycle walkthrough to keep in
sync.

### 1. GitHub source

Ask which repo(s) to monitor and whether to turn polling on now. Point at the
concrete fields: `sources.github.repos`, `sources.github.enabled`. Mention
that Wake owns the `wake:status.*` label family on issues it works, so the
user isn't surprised by labels appearing later.

### 2. Runner / tier

Ask which agent CLI(s) the user has authenticated on their host (Claude,
Codex, Cursor) and which model tier they want as default. Point at
`config.workflows.yaml`'s existing `runners` / `tiers` / `defaultTier` keys
(already scaffolded with sensible defaults) rather than asking the user to
write runner entries from scratch — this is a "pick from what's already
there, or add a named runner following the existing pattern" task, not a
blank-page task.

### 3. Credential mounts (detect-first)

This is the one step where the agent should not open by asking the user a
question. Given the runner(s) chosen in step 2, it should first check the
host filesystem for the known credential file locations per runner kind:

- `~/.claude/.credentials.json` + `~/.claude/settings.json` → Claude
- `~/.codex/config.toml` + `~/.codex/auth.json` → Codex
- `~/.config/cursor/auth.json` → Cursor

For whichever files are found, it proposes the corresponding
`sandbox.extraMounts` entries with the `readOnly` defaults documented in
`configuration.md` (`.credentials.json`/`auth.json` read-only, `settings.json`
writable) and asks the user to confirm or adjust — not to supply paths from
nothing. Only when none of the expected files exist for the chosen runner
does it fall back to asking the user directly where their credentials live
(non-default `CODEX_HOME`, unusual OS layout, etc.). This keeps the interview
short in the common case and only prompts when detection genuinely fails.

It explicitly repeats the existing warning from `configuration.md`: never
mount the whole `~/.claude` (or `~/.codex`, `~/.cursor`) directory — only the
specific files above.

### Hosted doc links, not duplicated content

Each section ends with a link to the relevant anchor in the hosted
`docs/configuration.md` on GitHub
(`https://github.com/atolis-hq/wake/blob/main/docs/configuration.md#...`) for
full field-by-field detail, rather than restating it. A closing section links
`docs/getting-started.md` (sandbox build/up/down) and
`docs/runner-comparison.md`, so an agent that gets asked about anything past
initial config (e.g. "how do I actually start this thing," "which runner is
cheapest") has somewhere to fetch the answer instead of guessing. Hosted
links were chosen over bundling copies of those docs into the wake home
because `docs/` isn't otherwise scaffolded into a packaged install, and a
bundled copy would need to be kept in sync with the source doc at release
time.

## Docs cross-reference

Add one line to `docs/getting-started.md` noting that `wake init` also
scaffolds `SETUP.md`, an agent-directed guide to finishing configuration —
per `CLAUDE.md`'s requirement that reference docs describe current CLI
behavior.

## Out of scope

- No templating engine or interpolated config values in `SETUP.md`.
- No new `wake configure` CLI command — this is a scaffolded file, not new
  command surface.
- No duplication of the sandbox build/up/down walkthrough.
- No change to `wake sandbox` or config-loading behavior.
