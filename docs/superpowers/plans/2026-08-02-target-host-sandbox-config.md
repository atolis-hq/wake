# Target Host Sandbox Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated target `host.sandbox` and `host.development` configuration and compose it into Docker and self-update operational applications.

**Architecture:** The strict root schema owns the host deployment configuration. Bootstrap consumes resolved host values while Surface Docker helpers retain injected process boundaries. Domains receive no Docker, mount, source-install, or packaging concerns.

**Tech Stack:** TypeScript, Zod, Vitest, target Bootstrap and Surfaces modules.

---

### Task 1: Define the host configuration contract

**Files:**
- Modify: `src-next/bootstrap/config/root-schema.ts`
- Create: `test-next/bootstrap/host-config.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
expect(parseRootConfig(baseConfig)).toMatchObject({
  host: {
    sandbox: {
      image: 'wake-sandbox',
      imageRepository: 'wake-sandbox',
      containerName: 'wake-sandbox',
      wakeMountPath: '/wake',
      containerHomeMountPath: '/home/wake',
      start: { enabled: true },
      extraMounts: [],
    },
    development: {},
  },
});

expect(() => parseRootConfig({ ...baseConfig, host: { development: { mode: 'source' } } }))
  .toThrow('repoRoot');
```

- [ ] **Step 2: Run the test and observe failure**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/host-config.test.ts`

Expected: FAIL because `host` is rejected by the strict root schema.

- [ ] **Step 3: Add strict `host` schema and resolved type**

Add a `hostConfigSchema` to `root-schema.ts` with `sandbox` defaults from the approved design. `extraMounts` entries require non-empty `source` and `target`; `development.mode` is `source | packaged`; a `superRefine` requires `development.repoRoot` when mode is `source`. Add `host` to `rootConfigSchema` and `ResolvedWakeModulesConfig`.

- [ ] **Step 4: Run the schema test**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/host-config.test.ts`

Expected: PASS.

### Task 2: Generate an explicit host configuration in init

**Files:**
- Modify: `src-next/bootstrap/initialise.ts`
- Modify: `test-next/bootstrap/initialise.test.ts`

- [ ] **Step 1: Write a failing init assertion**

```ts
const config = await readFile(join(root, 'config.yaml'), 'utf8');
expect(config).toContain('host:');
expect(config).toContain('sandbox:');
expect(config).toContain('containerName: wake-sandbox');
```

- [ ] **Step 2: Run it and observe failure**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/initialise.test.ts`

Expected: FAIL because target init has no `host` block.

- [ ] **Step 3: Add the default host YAML**

Add `host.sandbox` fields approved in the design, keeping `host.development` empty so a freshly initialized packaged-neutral root remains valid.

- [ ] **Step 4: Run init tests**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/initialise.test.ts`

Expected: PASS.

### Task 3: Compose configured sandbox Docker behavior

**Files:**
- Modify: `src-next/surfaces/cli/infrastructure/docker-cli.ts`
- Modify: `src-next/bootstrap/surface-cli-applications.ts`
- Modify: `test-next/surfaces/cli-infrastructure.test.ts`

- [ ] **Step 1: Write failing Docker argument tests**

```ts
const port = createSandboxDockerPort(docker, {
  wakeRoot: '/wake-root',
  containerHomeRoot: '/wake-root/.wake/container-home',
  image: 'configured-image',
  containerName: 'configured-name',
  wakeMountPath: '/workspace',
  containerHomeMountPath: '/home/runner',
  extraMounts: [{ source: '/repos', target: '/repos', readOnly: true }],
  startEnabled: true,
});
await port.up();
expect(calls).toContainEqual(['run', '-d', '--name', 'configured-name', /* mount and start flags */]);
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `npx vitest run --config vitest.next.config.ts test-next/surfaces/cli-infrastructure.test.ts`

Expected: FAIL because the port only mounts the fixed `/wake` path.

- [ ] **Step 3: Extend `SandboxDockerOptions` and run arguments**

Add configured Wake/container-home mounts and `extraMounts`, append `:ro` only for read-only entries, and inject `WAKE_START_ENABLED=true` only when configured. Bootstrap supplies values from `root.config.host.sandbox` and the target-owned `.wake/container-home` root.

- [ ] **Step 4: Run Docker tests**

Run: `npx vitest run --config vitest.next.config.ts test-next/surfaces/cli-infrastructure.test.ts`

Expected: PASS.

### Task 4: Apply source/package update policy

**Files:**
- Modify: `src-next/bootstrap/surface-cli-applications.ts`
- Modify: `test-next/bootstrap/self-update-application.test.ts`

- [ ] **Step 1: Write failing self-update policy tests**

```ts
await expect(applicationFor({ mode: 'packaged' }).updateLatest()).rejects.toThrow(
  'requires host.development.mode: source',
);
```

- [ ] **Step 2: Run and observe failure**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/self-update-application.test.ts`

Expected: FAIL because the CLI currently accepts only a manual `--repo-root`.

- [ ] **Step 3: Compose update from host configuration**

For `host.development.mode: source`, use configured `repoRoot` and `imageRepository`; for packaged mode, reject source self-update with an explicit host-policy error. Remove the manual `--repo-root` requirement after adding direct CLI reachability tests.

- [ ] **Step 4: Run self-update tests**

Run: `npx vitest run --config vitest.next.config.ts test-next/bootstrap/self-update-application.test.ts test-next/surfaces/self-update.test.ts`

Expected: PASS.

### Task 5: Verify and document

**Files:**
- Modify: `docs/architecture/task26-operational-parity.md`
- Modify: `src-next/surfaces/cli/cli-surface.spec.md`

- [ ] **Step 1: Record configured host adaptation evidence**

Update the checklist with host configuration fields, Docker mount behavior, and source/package policy. Do not mark unrelated auth/resume/tunnel capabilities complete.

- [ ] **Step 2: Run focused target gate**

Run: `npx vitest run --config vitest.next.config.ts test-next/surfaces test-next/bootstrap test-next/e2e/scenarios/doctor-rebuild.test.ts`

Expected: PASS.

- [ ] **Step 3: Run target verification**

Run: `npm run verify:next`

Expected: PASS.