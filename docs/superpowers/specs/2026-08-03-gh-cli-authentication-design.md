# GitHub CLI Authentication for Wake Next

## Goal

Let a Wake Next sandbox authenticate GitHub polling and publication through its
own `gh auth login` session, without storing a GitHub token in Wake config.

## Design

The sandbox Dockerfile will install the GitHub CLI alongside the existing
agent CLIs. During `wake sandbox setup`, an operator authenticates `gh` inside
the container. The GitHub provider resolves the current session credential by
running `gh auth token` once while composing the provider, then creates its
existing Octokit client with that in-memory token. The token is never written
to config, logs, or state.

`integrations.github.token` becomes optional and is removed from the scaffold
guidance. Existing explicit tokens remain supported as an override so existing
homes retain compatibility; the CLI-derived credential is used when no token
is configured. A failed or unauthenticated `gh auth token` call produces an
actionable error directing the operator to run `gh auth login` in the sandbox.

## Verification

Unit tests cover token resolution success, command failure, and explicit-token
precedence. Bootstrap tests assert that generated Dockerfiles install `gh`.
The targeted integration suite validates that the revised config loads without
a `token` field.
