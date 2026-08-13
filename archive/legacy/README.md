# Legacy Wake Archive

This directory is retained solely as behavioural evidence for the pre-cutover
Wake implementation. It is excluded from active build, test, lint, formatting,
package, and runtime paths. Target code MUST NOT import it.

`archive/legacy/` is the single future deletion target once its retention
period ends. No compatibility or bridge layer exists between this archive and
the target architecture.
