# Agent Setup Guide (`SETUP.md`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wake init` scaffolds a static, agent-directed `SETUP.md` into every new wake home so an assisting agent can finish configuring `sources.github`, the runner/tier, and `sandbox.extraMounts` without the user reading all of `docs/configuration.md` first.

**Architecture:** One new static content file (`templates/SETUP.md` in the wake repo) copied verbatim by `scaffoldWakeHome` into the wake home root, the same way `prompts/*.md` are already copied. No templating, no new CLI command, no change to config schema.

**Tech Stack:** TypeScript, Node `fs/promises`, Vitest.

## Global Constraints

- Static content only — no interpolation of live config values into `SETUP.md` (per spec: "Static text").
- Config-only scope — `SETUP.md` must not re-explain `wake sandbox build`/`up`/`down`; it links `docs/getting-started.md` instead.
- Credential-mount guidance must be detect-first: check for known host credential file paths before asking the user, per runner kind (Claude/Codex/Cursor), and only fall back to asking when none are found.
- Hosted doc links point at `https://github.com/atolis-hq/wake/blob/main/docs/...`, not bundled copies of those docs.
- Reference docs (`docs/getting-started.md`) must describe current CLI behavior — add the one-line cross-reference per `CLAUDE.md`'s doc requirement.
- Run `npm run verify` before considering any task done, per `CLAUDE.md`.

---

### Task 1: Scaffold `SETUP.md` from a new `templates/` source file

**Files:**
- Create: `templates/SETUP.md`
- Modify: `src/cli/scaffold-assets.ts:112-123` (the `Promise.all` inside `scaffoldWakeHome`)
- Modify: `package.json` (`"files"` array, currently `package.json:X` listing `dist/src`, `docker`, `prompts`, `README.md`, `LICENSE`)
- Modify: `test/cli/scaffold-assets.test.ts` (`makeScaffoldableRepoRoot` helper, plus a new `describe` block)
- Modify: `test/cli/init-command.test.ts` (add one assertion to the existing scaffold test)

**Interfaces:**
- Consumes: `scaffoldWakeHome(input: { wakeRoot: string; repoRoot: string; devModeOverride?: 'source' | 'packaged' })` — existing signature in `src/cli/scaffold-assets.ts:75`, unchanged.
- Produces: after this task, every `scaffoldWakeHome` call also writes `<wakeRoot>/SETUP.md`, a byte-for-byte copy of `<repoRoot>/templates/SETUP.md`. Later tasks (none currently planned) can rely on `<wakeRoot>/SETUP.md` existing whenever `<repoRoot>/templates/SETUP.md` exists.

- [ ] **Step 1: Write the failing test for scaffolded `SETUP.md` content**

Add this new `describe` block to `test/cli/scaffold-assets.test.ts`, after the existing `describe('scaffoldWakeHome runtime directories', ...)` block (around line 150):

```typescript
describe('scaffoldWakeHome SETUP.md', () => {
  it('copies templates/SETUP.md from repoRoot verbatim into the wake home root', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');
    const source = await readFile(join(repoRoot, 'templates', 'SETUP.md'), 'utf8');

    expect(scaffolded).toBe(source);
  });

  it('covers the GitHub source, runner/tier, and credential-mount sections', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');

    expect(scaffolded).toContain('sources:');
    expect(scaffolded).toContain('github:');
    expect(scaffolded).toContain('extraMounts');
    expect(scaffolded).toContain('.credentials.json');
    expect(scaffolded).toContain('defaultTier');
    expect(scaffolded).toContain('https://github.com/atolis-hq/wake/blob/main/docs/configuration.md');
    expect(scaffolded).toContain('https://github.com/atolis-hq/wake/blob/main/docs/getting-started.md');
  });

  it('contains no template placeholders — content is static, not interpolated', async () => {
    const wakeRoot = await makeTempWakeRoot();
    const repoRoot = process.cwd();

    await scaffoldWakeHome({ wakeRoot, repoRoot });

    const scaffolded = await readFile(join(wakeRoot, 'SETUP.md'), 'utf8');

    expect(scaffolded).not.toMatch(/\{\{.*\}\}/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run test/cli/scaffold-assets.test.ts -t "SETUP.md"`
Expected: FAIL — `templates/SETUP.md` does not exist yet, and `scaffoldWakeHome` does not write `SETUP.md` into `wakeRoot`, so `readFile(join(wakeRoot, 'SETUP.md'), 'utf8')` rejects with `ENOENT`.

- [ ] **Step 3: Write `templates/SETUP.md`**

Create `templates/SETUP.md` with this exact content:

```markdown
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

`config.workflows.yaml` already has working `runners` entries for
`claude-haiku`, `claude-opus`, `codex-mini`, `codex-flagship`, and
`cursor-composer`, grouped into `tiers` (`light`/`standard`/`deep`) with
`defaultTier: standard`. Don't rewrite this from scratch — pick which
runner(s) the user actually has access to, and either:

- adjust `tiers` so each tier only lists runners the user can actually use, or
- if the user has a runner not already listed (a different model, a
  different CLI), add a new named entry under `runners` following the
  existing pattern, then reference it from `tiers`.

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
```

- [ ] **Step 4: Wire the copy into `scaffoldWakeHome`**

In `src/cli/scaffold-assets.ts`, the `Promise.all` block currently reads (lines 119–123):

```typescript
  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    writeYamlFile(join(wakeRoot, 'config.yaml'), infra),
    writeYamlFile(join(wakeRoot, 'config.workflows.yaml'), workflow),
  ]);
```

Change it to:

```typescript
  await Promise.all([
    copyAssets(repoRoot, 'prompts', join(wakeRoot, 'prompts'), promptFileNames),
    copyFile(join(repoRoot, 'templates', 'SETUP.md'), join(wakeRoot, 'SETUP.md')),
    writeYamlFile(join(wakeRoot, 'config.yaml'), infra),
    writeYamlFile(join(wakeRoot, 'config.workflows.yaml'), workflow),
  ]);
```

`copyFile` is already imported at the top of this file from `node:fs/promises` (line 1) — no import changes needed.

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run test/cli/scaffold-assets.test.ts -t "SETUP.md"`
Expected: PASS (all 3 new tests).

- [ ] **Step 6: Update the packaged-repo test fixture so unrelated tests keep passing**

`test/cli/scaffold-assets.test.ts`'s `makeScaffoldableRepoRoot` helper builds a synthetic `repoRoot` containing only `prompts/` and `docker/` subsets, used by the `detectDevMode`/`dev.mode` tests. Since `scaffoldWakeHome` now also reads `templates/SETUP.md` from `repoRoot`, add that file to the synthetic fixture too, or every test using `makeScaffoldableRepoRoot` will start failing with `ENOENT`.

Change `makeScaffoldableRepoRoot` (currently lines 22–37) from:

```typescript
async function makeScaffoldableRepoRoot(hasSrcCheckout: boolean): Promise<string> {
  const repoRoot = hasSrcCheckout ? await makeSourceRepoRoot() : await makePackagedRepoRoot();
  const cwd = process.cwd();

  await mkdir(join(repoRoot, 'prompts'), { recursive: true });
  for (const promptFile of ['refine.md', 'implement.md']) {
    await copyFile(join(cwd, 'prompts', promptFile), join(repoRoot, 'prompts', promptFile));
  }

  await mkdir(join(repoRoot, 'docker'), { recursive: true });
  for (const dockerAsset of ['Dockerfile', 'setup.sh', 'log-command.sh']) {
    await copyFile(join(cwd, 'docker', dockerAsset), join(repoRoot, 'docker', dockerAsset));
  }

  return repoRoot;
}
```

to:

```typescript
async function makeScaffoldableRepoRoot(hasSrcCheckout: boolean): Promise<string> {
  const repoRoot = hasSrcCheckout ? await makeSourceRepoRoot() : await makePackagedRepoRoot();
  const cwd = process.cwd();

  await mkdir(join(repoRoot, 'prompts'), { recursive: true });
  for (const promptFile of ['refine.md', 'implement.md']) {
    await copyFile(join(cwd, 'prompts', promptFile), join(repoRoot, 'prompts', promptFile));
  }

  await mkdir(join(repoRoot, 'docker'), { recursive: true });
  for (const dockerAsset of ['Dockerfile', 'setup.sh', 'log-command.sh']) {
    await copyFile(join(cwd, 'docker', dockerAsset), join(repoRoot, 'docker', dockerAsset));
  }

  await mkdir(join(repoRoot, 'templates'), { recursive: true });
  await copyFile(join(cwd, 'templates', 'SETUP.md'), join(repoRoot, 'templates', 'SETUP.md'));

  return repoRoot;
}
```

- [ ] **Step 7: Add a scaffolded-`SETUP.md` assertion to `init-command.test.ts`**

In `test/cli/init-command.test.ts`, in the existing test `'scaffolds a wake home with config, prompts, and runtime directories, without docker assets or launchers'` (starts at line 27), add this assertion after the existing prompt-file assertions (after line 55, before the runtime-directory loop at line 57):

```typescript
    const setupGuide = await readFile(join(result.wakeRoot, 'SETUP.md'), 'utf8');
    expect(setupGuide).toContain('sources:');
    expect(setupGuide).toContain('extraMounts');
```

- [ ] **Step 8: Add `templates` to the npm package manifest**

In `package.json`, change the `"files"` array from:

```json
  "files": [
    "dist/src",
    "docker",
    "prompts",
    "README.md",
    "LICENSE"
  ],
```

to:

```json
  "files": [
    "dist/src",
    "docker",
    "prompts",
    "templates",
    "README.md",
    "LICENSE"
  ],
```

Without this, a globally-installed `@atolis-hq/wake` (packaged mode) won't have `templates/SETUP.md` on disk to copy, and `wake init` will fail with `ENOENT` for every packaged-mode user.

- [ ] **Step 9: Run the full test suite and verify**

Run: `npm run verify`
Expected: PASS — lint, format:check, build, and all tests (including the new and modified ones above) succeed. If `format:check` flags files you didn't touch, ignore those (per `CLAUDE.md`'s Windows CRLF note), but confirm `templates/SETUP.md`, `src/cli/scaffold-assets.ts`, `test/cli/scaffold-assets.test.ts`, `test/cli/init-command.test.ts`, and `package.json` each show no diff under `npx prettier --check <file>`; if any do, run `npx prettier --write --end-of-line lf <file>` on it.

- [ ] **Step 10: Commit**

```bash
git add templates/SETUP.md src/cli/scaffold-assets.ts test/cli/scaffold-assets.test.ts test/cli/init-command.test.ts package.json
git commit -m "$(cat <<'EOF'
Scaffold agent-directed SETUP.md guide from wake init

Lets an assisting agent finish configuring sources.github, the
runner/tier, and sandbox.extraMounts without the user reading all of
docs/configuration.md first.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Cross-reference `SETUP.md` from `docs/getting-started.md`

**Files:**
- Modify: `docs/getting-started.md:28-30`

**Interfaces:**
- Consumes: nothing new — this is a doc-only change.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the "Install and initialize" section**

In `docs/getting-started.md`, this paragraph currently reads (lines 28–30):

```markdown
`wake init` scaffolds `config.yaml`, `config.workflows.yaml`, `prompts/`, and `workspaces/`. It does
not create `docker/` — that's written lazily by `wake sandbox build` (see
below).
```

Change it to:

```markdown
`wake init` scaffolds `config.yaml`, `config.workflows.yaml`, `prompts/`, `workspaces/`, and a
`SETUP.md` guide written for an assisting agent to read and use to finish
configuring the GitHub source, runner/tier, and credential mounts — point
your agent CLI at it (e.g. "read SETUP.md and help me configure this") once
`wake init` finishes. `wake init` does not create `docker/` — that's written
lazily by `wake sandbox build` (see below).
```

- [ ] **Step 2: Verify the diff reads correctly**

Run: `git diff docs/getting-started.md`
Expected: only the paragraph above changes; no other lines touched.

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md
git commit -m "$(cat <<'EOF'
Document that wake init scaffolds SETUP.md

Keeps getting-started.md accurate about what wake init produces, per
CLAUDE.md's documentation requirements.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
