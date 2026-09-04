# Atomic Release Versioning Design

## Goal

Allow the main-branch publish workflow to prepare and publish the three public
workspace packages without resolving an unpublished internal package from the
npm registry.

## Cause

The publish job runs `npm version` separately for each workspace. After the
first command changes Eventing's version, npm updates its workspace state while
Eventing filesystem still depends on the prior Eventing version. npm then tries
to resolve that old version from npmjs, where it has not been published.

## Design

The publish job will use `npm pkg set` to edit the version and exact internal
dependency fields in all three manifests. These commands do not ask npm to
resolve dependencies. Only after every manifest is consistent will the job run
`npm install --package-lock-only --ignore-scripts` once to regenerate the
lockfile.

The existing publication order remains Eventing, Eventing filesystem, then
Wake. The release-packaging architecture test will assert the manifest-only
commands and reject the former `npm version` commands.

## Verification

Run the focused release-packaging architecture test, then the full architecture
suite and `npm run check:workspace-packages`.
