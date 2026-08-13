# Target Host Sandbox Configuration Design

## Decision

Add target deployment configuration under `host`, not `surfaces` and not any domain module:

```yaml
host:
  sandbox:
    image: wake-sandbox
    imageRepository: wake-sandbox
    containerName: wake-sandbox
    wakeMountPath: /wake
    containerHomeMountPath: /home/wake
    start:
      enabled: true
    extraMounts: []

  development:
    repoRoot: /path/to/wake-source
    mode: source
```

`host.sandbox` describes the process/container that hosts Wake. CLI remains the
operator surface; Bootstrap selects and configures Docker infrastructure; domain
modules remain unaware of Docker, mounted filesystems, and source packaging.

## Field mapping

| Target field | Legacy source | Purpose |
| --- | --- | --- |
| `host.sandbox.image` | `sandbox.image` | Resolved image used by build, up, and update. |
| `host.sandbox.imageRepository` | `sandbox.imageRepository` | Untagged repository used by source self-update rollouts. |
| `host.sandbox.containerName` | `sandbox.containerName` | Stable container identity. |
| `host.sandbox.wakeMountPath` | `sandbox.containerMountPath` | Container target for the Wake root. |
| `host.sandbox.containerHomeMountPath` | `sandbox.containerHomeMountPath` | Container target for target-owned container-home artifacts. |
| `host.sandbox.start.enabled` | `sandbox.start.enabled` | Whether the container starts the resident host. |
| `host.sandbox.extraMounts` | `sandbox.extraMounts` | Explicit host-to-container mounts, optionally read-only. |
| `host.development.repoRoot` | `dev.repoRoot` | Source checkout used only by source-mode build/update. |
| `host.development.mode` | `dev.mode` | Explicit `source` or `packaged` installation policy. |

The host path for `containerHome` remains target-owned under `.wake`; it is not
operator-configurable.

## Deliberate exclusions

- No `enabled`, stop-timeout, or log-retention fields: target uses bounded
  operational defaults until an operator requirement establishes configurability.
- No auth credentials: provider auth is interactive and must not enter YAML.
- No provider session/resume configuration: target Runner contracts have no
  portable provider-session model.
- No tunnel configuration: remote exposure needs a separate security design.

## Validation and behavior

The strict root schema gains a strict `host` object with defaults. `mode: source`
requires a non-empty `repoRoot`; packaged mode does not. Mount source and target
are non-empty paths. Bootstrap passes resolved host sandbox values to Docker
composition, source-update composition, and doctor diagnostics. Docker command
primitives remain injected Surface infrastructure and do not become domain ports.

## Tests

- Root-schema tests prove defaults, strict rejection, source-mode `repoRoot`
  validation, and mount validation.
- Docker composition tests prove configured image, name, mount paths, start
  mode, and read-only extra mounts reach the injected Docker boundary.
- Self-update tests prove packaged mode refuses source checkout updates and
  source mode uses the configured repository/image repository.
- Doctor tests report host sandbox configuration and Docker availability without
  mutating canonical events.