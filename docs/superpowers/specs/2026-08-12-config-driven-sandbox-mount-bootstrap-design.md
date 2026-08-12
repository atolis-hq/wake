# Config-Driven Sandbox Mount Bootstrap Design

## Problem

Docker creates missing parent directories for a bind-mounted credential target as
root. When an `extraMount` targets a nested path under the persistent sandbox
home, the unprivileged `wake` user can then be unable to create adjacent runtime
state. In production, mounting Cursor credentials at
`/home/wake/.config/cursor/auth.json` created `/home/wake/.config` as root-only
and prevented `gh` from persisting its login in `/home/wake/.config/gh`.

## Decision

Sandbox container creation derives the parent directories of every configured
`host.sandbox.extraMounts[*].target` that is strictly below
`host.sandbox.containerHomeMountPath`. It serializes that derived, de-duplicated
list into a sandbox-only environment variable.

The generated sandbox image starts as root through a small entry wrapper. Before
the resident entrypoint runs, the wrapper creates and gives ownership of exactly
the configured parent directories to the image's existing `wake` user. It never
changes a configured mount target itself. It then drops privileges and execs the
existing source or packaged Wake entrypoint. Host-mode execution never uses this
wrapper or environment variable.

## Boundaries

- Paths outside `containerHomeMountPath` are ignored.
- A target equal to the home mount itself has no parent to prepare.
- Parent paths are normalized, de-duplicated, and passed as data; no runner or
  credential-specific path is hard-coded.
- The wrapper changes only directory ownership. It neither reads nor changes a
  mounted credential file or directory.
- The change applies to both generated source and packaged Dockerfiles.

## Verification

Unit/integration tests prove that container creation emits the derived sandbox
environment only for targets below the configured home, and generated Dockerfile
tests prove the root bootstrap and privilege drop are present. A real sandbox
rebuild/recreate then verifies `gh auth status` persists after `sandbox setup`.
