# Fastify UI Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Wake's bespoke HTTP server and hand-rolled UI session handling with Fastify route scopes and secure-session authentication.

**Architecture:** A Fastify factory in `surfaces` will register public auth routes, a protected API route scope which delegates to the existing typed `ApiDispatcher`, and the existing asset source/SPA fallback. Bootstrap supplies mandatory persisted credentials and starts the Fastify instance. The React app queries session state before mounting operational pages and posts the operator access key to the public login route.

**Tech Stack:** Node 24, TypeScript, Fastify, `@fastify/secure-session`, React, Vitest.

---

### Task 1: Add Fastify dependencies and characterize the transport contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/integration/surfaces/web-server.test.ts`

- [ ] **Step 1: Write failing transport tests for the future factory**

  Add `createSurfaceHttpServer({ dispatcher, assets, auth })` tests using Fastify's
  `inject()` for: SPA fallback, unknown API 404 as `application/problem+json`,
  `HEAD` response with no body, malformed JSON 400, and no static response to a
  mutation request.

  ```ts
  const server = createSurfaceHttpServer({ dispatcher: createApiDispatcher(applications()), auth });
  const response = await server.inject({ method: 'GET', url: '/api/v1/nope' });
  expect(response.statusCode).toBe(401);
  ```

- [ ] **Step 2: Run the focused test and observe the missing factory failure**

  Run: `npx vitest run test/integration/surfaces/web-server.test.ts`

  Expected: FAIL because `createSurfaceHttpServer` does not yet exist.

- [ ] **Step 3: Install only the transport/session dependencies**

  Run: `npm install fastify @fastify/secure-session`

  Confirm `package.json` and `package-lock.json` contain no web framework,
  database, or identity-provider dependency beyond these two packages.

- [ ] **Step 4: Commit the dependency-only change**

  ```powershell
  git add package.json package-lock.json
  git commit -m "build: add Fastify surface dependencies"
  ```

### Task 2: Persist credentials and expose only a small auth domain

**Files:**
- Create: `src/surfaces/auth/credentials.ts`
- Create: `src/surfaces/auth/access-key.ts`
- Modify: `src/surfaces/index.ts`
- Test: `test/unit/surfaces/auth.test.ts`

- [ ] **Step 1: Write failing credential and key-verification tests**

  Cover creation below `.wake/auth/credentials.json`, private permissions where
  supported, rejection of an empty replacement key, constant-time comparison,
  and replacement producing a new session password.

  ```ts
  const first = await loadOrCreateCredentials(root);
  const replacement = await replaceAccessKey(root, 'operator-key');
  expect(replacement.accessKey).toBe('operator-key');
  expect(replacement.sessionPassword).not.toBe(first.sessionPassword);
  expect(verifyAccessKey('operator-key', replacement.accessKey)).toBe(true);
  ```

- [ ] **Step 2: Run the unit test and observe imports fail**

  Run: `npx vitest run test/unit/surfaces/auth.test.ts`

  Expected: FAIL because the auth modules are absent.

- [ ] **Step 3: Implement the minimal filesystem credential store**

  Implement `loadOrCreateCredentials(wakeRoot)` and
  `replaceAccessKey(wakeRoot, accessKey)`. Generate the access key and Fastify
  session password with `randomBytes`, write atomically with mode `0600`, validate
  decoded fields, and rotate `sessionPassword` whenever the access key changes.
  Implement `verifyAccessKey` with equal-length `timingSafeEqual` inputs.

- [ ] **Step 4: Re-run the unit test**

  Run: `npx vitest run test/unit/surfaces/auth.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit the auth credential boundary**

  ```powershell
  git add src/surfaces/auth test/unit/surfaces/auth.test.ts src/surfaces/index.ts
  git commit -m "feat: persist UI auth credentials"
  ```

### Task 3: Replace `node:http` transport with scoped Fastify routes

**Files:**
- Replace: `src/surfaces/api/http-server.ts`
- Modify: `src/surfaces/contracts/http.ts`
- Modify: `src/surfaces/index.ts`
- Modify: `test/integration/surfaces/web-server.test.ts`

- [ ] **Step 1: Add failing access-boundary tests**

  Add tests proving an anonymous operational request is rejected in `onRequest`
  before body parsing; a huge invalid JSON POST must receive 401 rather than
  malformed-json or dispatcher execution. Add tests for the two public auth
  routes, invalid login, valid login cookie, and session invalidation after
  access-key rotation.

  ```ts
  const denied = await server.inject({
    method: 'POST', url: '/api/v1/control-plane/commands/tick',
    payload: 'x'.repeat(1024 * 1024),
  });
  expect(denied.statusCode).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
  ```

- [ ] **Step 2: Run the focused test and observe the authorization failures**

  Run: `npx vitest run test/integration/surfaces/web-server.test.ts`

  Expected: FAIL because existing transport has no mandatory route-scoped auth.

- [ ] **Step 3: Implement `createSurfaceHttpServer`**

  Construct a Fastify instance with a conservative global `bodyLimit` and a
  custom error handler that preserves the current problem-detail response
  contract. Register `@fastify/secure-session` with the credential session
  password. Register exactly these public routes:

  ```ts
  app.get('/api/v1/auth/session', sessionHandler);
  app.post('/api/v1/auth/login', { bodyLimit: 1024 }, loginHandler);
  ```

  Register existing dispatcher routes inside a `/api/v1` plugin with an
  `onRequest` hook that returns 401 when `request.session.get('operator')` is
  absent. The hook must precede parsing. Delegate matched calls with the
  current `ApiDispatcher.dispatch(method, pathWithSearch, body)` contract.
  Register the AssetSource and current SPA fallback only outside this API
  plugin; preserve cache-control and HEAD semantics.

- [ ] **Step 4: Run the focused transport suite**

  Run: `npx vitest run test/integration/surfaces/web-server.test.ts`

  Expected: PASS, including anonymous body rejection before parsing.

- [ ] **Step 5: Commit the Fastify transport**

  ```powershell
  git add src/surfaces/api/http-server.ts src/surfaces/contracts/http.ts src/surfaces/index.ts test/integration/surfaces/web-server.test.ts
  git commit -m "feat: secure surface routes with Fastify"
  ```

### Task 4: Make Bootstrap and CLI auth mandatory

**Files:**
- Modify: `src/bootstrap/surface-cli-applications.ts`
- Modify: `src/surfaces/cli/main.ts`
- Modify: `src/surfaces/cli/usage.ts`
- Modify: `test/integration/surfaces/cli-main-contract.test.ts`
- Modify: `test/integration/surfaces/cli-runtime-commands.test.ts`

- [ ] **Step 1: Write failing CLI contract tests**

  Assert `wake ui token` prints the stored key, `wake ui token set example`
  replaces it, empty keys fail, and both `wake api` and `wake ui` use the same
  mandatory credential-backed Fastify factory.

- [ ] **Step 2: Run the CLI tests**

  Run: `npx vitest run test/integration/surfaces/cli-main-contract.test.ts test/integration/surfaces/cli-runtime-commands.test.ts`

  Expected: FAIL because `ui token` is not a CLI command and startup still
  constructs the old HTTP server.

- [ ] **Step 3: Implement the CLI and Bootstrap composition**

  Add `ui token` and `ui token set <key>` parsing and usage lines. Expose an
  `auth` application from `createSurfaceCliApplications`. Before any server
  listens, load credentials and pass them to `createSurfaceHttpServer`; do not
  expose an optional-auth construction path.

- [ ] **Step 4: Re-run the CLI tests**

  Run: `npx vitest run test/integration/surfaces/cli-main-contract.test.ts test/integration/surfaces/cli-runtime-commands.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit the CLI surface**

  ```powershell
  git add src/bootstrap/surface-cli-applications.ts src/surfaces/cli test/integration/surfaces/cli-main-contract.test.ts test/integration/surfaces/cli-runtime-commands.test.ts
  git commit -m "feat: add UI access-key commands"
  ```

### Task 5: Add the browser login gate and migrate browser fixtures

**Files:**
- Modify: `src/surfaces/web/src/app/app.tsx`
- Modify: `src/surfaces/web/src/api/client.ts`
- Modify: `src/surfaces/web/e2e/surface-fixture.ts`
- Modify: `src/surfaces/web/e2e/operator-journey.spec.ts`
- Modify: `src/surfaces/web/test/app.test.tsx`
- Modify: `src/surfaces/web/test/client.test.ts`

- [ ] **Step 1: Write failing web tests**

  Test initial unauthenticated render shows only login, successful login mounts
  the existing routes, and an API 401 clears rendered operational state. Update
  the E2E fixture to create credentials and authenticate the browser before
  asserting board data.

- [ ] **Step 2: Run the focused web tests**

  Run: `npm run test:web -- --run test/app.test.tsx test/client.test.ts`

  Expected: FAIL because `App` currently mounts operator routes immediately.

- [ ] **Step 3: Implement login state**

  Add `WakeApiClient.auth.session()` and `WakeApiClient.auth.login(accessKey)`.
  Render a small password-input login form until session succeeds. Do not place
  the access key in local/session storage; rely on the secure HttpOnly session
  cookie. Translate a subsequent 401 into a logged-out application state.

- [ ] **Step 4: Re-run focused web tests**

  Run: `npm run test:web -- --run test/app.test.tsx test/client.test.ts`

  Expected: PASS.

- [ ] **Step 5: Commit the browser gate**

  ```powershell
  git add src/surfaces/web
  git commit -m "feat: require login before rendering Wake UI"
  ```

### Task 6: Update current-state references and run layered verification

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/specs/control-plane-ui.md`

- [ ] **Step 1: Update user-facing documentation**

  Describe that API/UI servers require login, show `wake ui token` and
  `wake ui token set <key>`, name `.wake/auth/credentials.json` as sensitive
  local state without displaying its contents, and document the public login
  endpoints versus protected operational API.

- [ ] **Step 2: Run all directly affected suites**

  Run: `npx vitest run test/unit/surfaces/auth.test.ts test/integration/surfaces/web-server.test.ts test/integration/surfaces/cli-main-contract.test.ts test/integration/surfaces/cli-runtime-commands.test.ts && npm run test:web`

  Expected: all selected tests PASS.

- [ ] **Step 3: Run repository verification**

  Run: `npm run verify && npm run test:integration && npm run test:e2e`

  Expected: every command exits 0.

- [ ] **Step 4: Build and exercise the development sandbox**

  From `C:\Users\live\wake-home`, run the configured `wake-dev` sandbox build
  and publish flow. Confirm an unauthenticated request to an operational API
  returns 401, run `wake ui token`, log in through the published UI with that
  value, and confirm an authenticated board request succeeds.

- [ ] **Step 5: Commit documentation and verification-ready state**

  ```powershell
  git add README.md docs/configuration.md docs/specs/control-plane-ui.md
  git commit -m "docs: document control-plane UI login"
  ```
