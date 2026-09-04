# Embedded Eventing Runtime Design

## Goal

Publish only `@atolis-hq/wake` while retaining Eventing and Eventing filesystem
as independently built and tested internal workspaces.

## Distribution boundary

Wake's TypeScript output imports the two workspace names at runtime. Its package
build will therefore copy each workspace's built `dist` directory and package
manifest into `dist/src/node_modules/@atolis-hq/`. Node resolves those embedded
directories from Wake's `dist/src` entrypoint after installation. The package
does not require Eventing packages to exist on npm.

## Build and test boundary

The workspaces retain their names, project references, dedicated build scripts,
and dedicated tests. Their manifests become private and no longer advertise
public publication. Wake no longer declares them as registry dependencies.

## Release boundary

The release workflow versions and publishes only Wake. Package verification
packs Wake, installs that one archive into a clean temporary project, and proves
the embedded Eventing runtime packages and Wake CLI are available offline.
