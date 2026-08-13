# CLI help parity design

## Goal

Make target `src-next` help as informative and familiar as the legacy Wake
help, without hiding target-only commands.

## Output contract

`wake`, `wake --help`, `wake -h`, and `wake help` produce the same structured
help text before dependency composition.

The output retains the legacy title, command descriptions, **Getting started**
steps, and sandbox auto-delegation guidance for shared commands. It adds an
**Additional target commands** section for target-only public commands:

- `wake api` - run the target API surface;
- `wake sandbox-entrypoint` - run the sandbox resident entrypoint;
- `wake self-update` - safely update a source installation.

The help text does not advertise internal-only implementation commands.

## Boundaries

The change is limited to the target CLI usage constant and its public-main
contract tests. It does not change command parsing, command routing, output
for operational commands, package registration, or dependency construction.

## Verification

Tests assert the shared legacy structure, target-only section, and identical
text for all four help entry forms. Existing no-composition assertions remain
in place. Target lint, formatting, TypeScript, and focused CLI tests must
pass.
