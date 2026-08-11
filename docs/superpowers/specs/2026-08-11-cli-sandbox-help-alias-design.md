# CLI sandbox help alias design

## Goal

Make default Wake help link to the repository README and preserve a convenient
developer-facing sandbox help entry point.

## Behaviour

- Default help includes `https://github.com/atolis-hq/wake#readme` immediately
  after the Getting started section.
- `wake dev sandbox` is an alias for `wake sandbox`.
- `wake dev sandbox` with no child command, and `wake dev sandbox --help`,
  print sandbox-specific usage and return without composing Docker or invoking
  a sandbox operation.
- `wake dev sandbox <subcommand> ...` routes to the existing sandbox command
  parser and Docker boundary unchanged.

## Boundaries and verification

The Surface CLI parser normalizes the alias before operational dispatch. The
sandbox command module owns its subcommand list and supplies the help text, so
the top-level CLI does not duplicate Docker behaviour. Tests exercise both
help forms, an alias operation path, and the README link in default help.
