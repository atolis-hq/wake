# GitHub CLI Authentication for Wake Next Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure Wake Next’s GitHub provider from the sandbox’s authenticated GitHub CLI session without persisting a token in Wake configuration.

**Architecture:** Keep Octokit as the GitHub transport. Make the provider’s configuration token optional and resolve an absent token by invoking `gh auth token` while the provider is composed. The resolution boundary is injectable for focused tests; the provider continues to receive only a string credential and the rest of its transport remains unchanged.

**Tech Stack:** TypeScript, Node `child_process`, Zod, Vitest, Dockerfile.

---

### Task 1: Add a focused GitHub CLI credential resolver

**Files:**

- Create: `src-next/integrations/github/infrastructure/gh-auth.ts`
- Test: `test-next/unit/integrations/github/gh-auth.test.ts`

- [ ] **Step 1: Write failing resolver tests**

```ts
it('returns the trimmed credential from gh auth token', () => {
  expect(resolveGitHubCliToken(run)).toBe('gho_token');
});

it('explains how to authenticate when gh auth token fails', () => {
  expect(() => resolveGitHubCliToken(failingRun)).toThrow('gh auth login');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run test-next/unit/integrations/github/gh-auth.test.ts`

Expected: FAIL because `gh-auth.ts` does not exist.

- [ ] **Step 3: Implement the resolver**

```ts
export function resolveGitHubCliToken(
  run: (command: string, arguments_: readonly string[]) => string = runGhAuthToken,
): string {
  try {
    const token = run('gh', ['auth', 'token']).trim();
    if (token.length > 0) return token;
  } catch { /* surface the common remediation below */ }
  throw new Error('GitHub authentication is unavailable. Run `gh auth login` inside the Wake sandbox.');
}
```

Use `execFileSync` in `runGhAuthToken`, with UTF-8 output and inherited no token logging.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npx vitest run test-next/unit/integrations/github/gh-auth.test.ts`

Expected: PASS.

### Task 2: Make GitHub provider configuration tokenless by default

**Files:**

- Modify: `src-next/integrations/github/contracts/config.ts`
- Modify: `src-next/integrations/github/provider.ts`
- Test: `test-next/integration/integrations/provider-registry.test.ts`

- [ ] **Step 1: Add failing configuration and provider tests**

```ts
expect(gitHubConfigSchema.parse({ enabled: true, repositories, intake: [] }).token).toBeUndefined();
expect(resolveToken({ token: 'configured-token' })).toBe('configured-token');
expect(resolveToken({})).toBe('token-from-gh');
```

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `npx vitest run test-next/integration/integrations/provider-registry.test.ts test-next/unit/integrations/github/gh-auth.test.ts`

Expected: FAIL because `token` is required and provider resolution has no fallback.

- [ ] **Step 3: Implement optional config with explicit-token precedence**

Change `token` to `z.string().trim().min(1).optional()` and in the provider use `config.token ?? resolveGitHubCliToken()` before calling `createGitHubClient`. Preserve configured token support for existing Wake homes.

- [ ] **Step 4: Run targeted tests and verify they pass**

Run: `npx vitest run test-next/integration/integrations/provider-registry.test.ts test-next/unit/integrations/github/gh-auth.test.ts`

Expected: PASS.

### Task 3: Put GitHub CLI in the generated sandbox image

**Files:**

- Modify: `src-next/bootstrap/initialise.ts`
- Modify: `test-next/integration/bootstrap/initialise.test.ts`

- [ ] **Step 1: Extend the scaffold assertion to require `gh`**

```ts
expect(dockerfile).toContain('gh');
```

- [ ] **Step 2: Run the bootstrap test and verify it fails**

Run: `npx vitest run test-next/integration/bootstrap/initialise.test.ts`

Expected: FAIL because the Dockerfile does not install the GitHub CLI.

- [ ] **Step 3: Install the GitHub CLI in the generated Dockerfile**

Add the official GitHub CLI apt repository and install `gh` in the existing apt setup layer, alongside `git`, `openssh-client`, `ca-certificates`, `curl`, and `gnupg`.

- [ ] **Step 4: Run the bootstrap test and verify it passes**

Run: `npx vitest run test-next/integration/bootstrap/initialise.test.ts`

Expected: PASS.

### Task 4: Verify the changed Next surface

**Files:**

- Modify: `src-next/bootstrap/initialise.ts` (only if scaffold comments or SETUP guidance still claim a configured token is required)
- Test: `test-next/unit/integrations/github/gh-auth.test.ts`
- Test: `test-next/integration/bootstrap/initialise.test.ts`
- Test: `test-next/integration/integrations/provider-registry.test.ts`

- [ ] **Step 1: Run formatting and targeted tests**

Run: `npx prettier --check src-next/integrations/github src-next/bootstrap/initialise.ts test-next/unit/integrations/github/gh-auth.test.ts test-next/integration/bootstrap/initialise.test.ts test-next/integration/integrations/provider-registry.test.ts && npx vitest run test-next/unit/integrations/github/gh-auth.test.ts test-next/integration/bootstrap/initialise.test.ts test-next/integration/integrations/provider-registry.test.ts`

Expected: all checks PASS.

- [ ] **Step 2: Run the Next unit suite**

Run: `npm run test:next:unit`

Expected: PASS.
