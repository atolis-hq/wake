# Wake Setup Guide (for the assisting agent)

You are reading this because a human just ran `wake init` and asked you to
help finish configuring this Wake home. This file is written as instructions
to you, the assisting agent — not as prose for a human to read top to bottom.

Read `config.yaml` and `config.workflows.yaml` in this directory now — both
already exist with working defaults from `wake init`. Everything below tells
you which fields in those two files to change. Edit them directly; don't
create a new `config.<label>.yaml` split unless the user asks for one.

Work through the three sections below in order, asking the user only what's
asked in each section. Each section links the relevant part of the hosted
`docs/configuration.md` for full field-by-field reference beyond what's
summarized here.

## 1. GitHub source

Ask the user:

- Which GitHub repo(s) should Wake monitor for issues? (`owner/repo` format)
- Should polling start immediately, or stay off until they're ready?

Edit in `config.yaml`:

```yaml
sources:
  github:
    enabled: true # or leave false to configure now, enable later
    repos: [owner/repo] # one or more, owner/repo format
```

Tell the user: once enabled, Wake adds/removes a
`wake:status.pending|working|failed|completed` label on issues it works, and
preserves any other labels already on the issue.

Full reference:
https://github.com/atolis-hq/wake/blob/main/docs/configuration.md#sourcesgithub

## 2. Runner and tier

Ask the user which agent CLI(s) they have authenticated on this host:
Claude, Codex, and/or Cursor.

`config.workflows.yaml` already has example `runners` entries for
`claude-haiku`, `claude-opus`, `codex-mini`, `codex-flagship`, and
`cursor-composer`, but every tier (`light`/`standard`/`deep`, with
`defaultTier: standard`) still points at the placeholder `fake` runner — none
of them route to a real runner yet. Don't rewrite this from scratch — pick
which runner(s) the user actually has access to, and either:

- repoint `tiers` so each tier lists the real named runner(s) the user can
  actually use instead of `fake`, or
- if the user has a runner not already listed (a different model, a
  different CLI), add a new named entry under `runners` following the
  existing pattern, then reference it from `tiers`.
- remove entries which are not needed.

Full reference:
https://github.com/atolis-hq/wake/blob/main/docs/configuration.md#runners
and
https://github.com/atolis-hq/wake/blob/main/docs/configuration.md#tiers

## 3. Credential mounts (check before asking)

Do not start by asking the user where their credentials are. First check the
host filesystem yourself for the files below, matching whichever runner(s)
were chosen in step 2:

- Claude: `~/.claude/.credentials.json` and `~/.claude/settings.json`
- Codex: `~/.codex/config.toml` and `~/.codex/auth.json`
- Cursor: `~/.config/cursor/auth.json`

For each file that exists, propose adding it to `sandbox.extraMounts` in
`config.yaml`, for example:

```yaml
sandbox:
  extraMounts:
    - source: /home/alice/.claude/.credentials.json
      target: /home/wake/.claude/.credentials.json
      readOnly: true
    - source: /home/alice/.claude/settings.json
      target: /home/wake/.claude/settings.json
      readOnly: false
```

`.credentials.json`/`auth.json` should be `readOnly: true` unless the user
wants the sandbox able to refresh tokens on the host's behalf. `settings.json`
must stay `readOnly: false` — Claude plugin commands write to it. Use the
actual host home directory path (resolve `~` yourself; don't write a literal
tilde into YAML).

Never mount the whole `~/.claude`, `~/.codex`, or `~/.cursor` directory —
only the specific files listed above. Mounting the whole directory leaks
OS-specific absolute paths (e.g. Windows plugin cache paths) into the Linux
sandbox and can cause the sandbox to overwrite the host's plugin bookkeeping.

Only if none of the expected files exist for the runner the user chose, ask
them directly where their credentials live (e.g. a custom `CODEX_HOME`).

Full reference:
https://github.com/atolis-hq/wake/blob/main/docs/configuration.md#sandbox

## After config looks right

Don't try to explain the sandbox lifecycle yourself — point the user at (or
fetch, if you have web access):

- https://github.com/atolis-hq/wake/blob/main/docs/getting-started.md —
  `wake sandbox build` / `up` / `setup` / `exec` / `down`
- https://github.com/atolis-hq/wake/blob/main/docs/runner-comparison.md —
  deeper comparison of runner tradeoffs if the user asks which to pick
- https://github.com/atolis-hq/wake/blob/main/docs/configuration.md — every
  config field, if something here doesn't cover their situation
