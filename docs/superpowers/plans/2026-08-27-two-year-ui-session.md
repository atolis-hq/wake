# Two-Year UI Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a successful Wake UI login valid through browser and Wake container restarts for two years.

**Architecture:** Keep the existing stateless encrypted Fastify session and durable `.wake/auth/credentials.json` signing key. Configure the two-year policy once in the HTTP surface and apply it both to Fastify's encrypted-payload expiry and to the browser cookie's persistent `Max-Age`; pairing grants remain single-use and ten minutes.

**Tech Stack:** TypeScript, Fastify, `@fastify/secure-session`, Vitest.

---

### Task 1: Prove the desired cookie contract

**Files:**
- Modify: `test/integration/surfaces/web-server.test.ts`
- Modify: `src/surfaces/api/http-server.ts`

- [x] **Step 1: Write the failing test**

Add a focused case after the existing successful-login test which posts the valid access key and asserts that the `Set-Cookie` header includes a two-year `Max-Age` value:

```ts
it('persists a two-year login cookie', async () => {
  const server = surfaceServer(createApiDispatcher(applications()));
  try {
    const login = await server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { accessKey: 'operator-key' },
    });
    expect(login.headers['set-cookie']).toContain('Max-Age=63072000');
  } finally {
    await server.close();
  }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/surfaces/web-server.test.ts -t "persists a two-year login cookie"`

Expected: FAIL because the current session cookie has no `Max-Age` attribute.

- [x] **Step 3: Write the minimal implementation**

In `createSurfaceHttpServer`, define the shared two-year duration in seconds and use it for both session mechanisms:

```ts
const twoYearsInSeconds = 2 * 365 * 24 * 60 * 60;

app.register(secureSession, {
  key: Buffer.from(options.credentials.sessionPassword, 'base64url'),
  cookieName: 'wake_session',
  expiry: twoYearsInSeconds,
  cookie: {
    httpOnly: true,
    maxAge: twoYearsInSeconds,
    sameSite: 'lax',
    secure: SurfaceCookieSecurity.Auto,
    path: '/',
  },
});
```

- [x] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run test/integration/surfaces/web-server.test.ts -t "persists a two-year login cookie"`

Expected: PASS.

- [x] **Step 5: Run the complete HTTP-surface suite**

Run: `npx vitest run test/integration/surfaces/web-server.test.ts`

Expected: PASS.

### Task 2: Document the two independent expiration policies

**Files:**
- Modify: `docs/configuration.md`
- Modify: `README.md`

- [x] **Step 1: State the durable session lifetime**

Amend the existing pairing-grant paragraph in `docs/configuration.md` to make the distinction explicit:

```md
# `wake ui token` creates a single-use login grant valid for ten minutes.
# Redeeming it creates a persistent operator session valid for two years; it
# survives browser and Wake-container restarts while `.wake/auth/credentials.json`
# remains intact. Replacing the access key invalidates all existing sessions.
```

- [x] **Step 2: Align the README operator description**

Add one sentence after the UI authentication paragraph:

```md
Successful operator logins persist for two years across browser and Wake-container restarts.
```

- [x] **Step 3: Run formatting and focused verification**

Run: `npm run format:check && npx vitest run test/integration/surfaces/web-server.test.ts`

Expected: both commands exit 0.

- [x] **Step 4: Commit the completed change**

```bash
git add src/surfaces/api/http-server.ts test/integration/surfaces/web-server.test.ts docs/configuration.md README.md docs/superpowers/plans/2026-08-27-two-year-ui-session.md
git commit -m "fix: persist UI sessions for two years"
```
