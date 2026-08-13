# Agent PR report and correlation design

## Goal

Keep a pull request link in the agent's human-facing completion report while
also requiring a fenced `wake-artifacts` JSON declaration, and reliably
correlate the declared PR to the run's WorkItem.

## Design

The implement prompt will explicitly require two distinct representations of
each PR: its URL in ordinary prose and the same URL in the `wake-artifacts`
fence immediately below that prose. The final terminal status remains after
both representations.

The existing agent-run publication parser will continue to remove only the
terminal status, preserving both the prose link and the artifact fence in the
published comment. The agent-result translator will extract the PR declaration
from the fence into a typed artifact claim. The artifact-registration reactor
will verify that claim against the workspace branch and correlate the verified
resource as primary to the workflow's WorkItem.

## Error handling

Malformed fences remain ordinary report text and do not create claims. Missing,
ambiguous, or branch-mismatched PRs remain uncorrelated and produce the
existing durable verification outcome.

## Tests

Unit coverage will assert the prompt's two-representation contract and that a
published report retains prose and fence. Integration coverage will pass a raw
agent response through accepted activity output and artifact registration,
then assert that the verified PR has a primary agent-reported correlation to
the originating WorkItem.
