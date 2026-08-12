# Transcript Capture and Retention Design

## Goal

Make raw agent prompt and response transcripts an opt-in operational artifact.
Operators can inspect a short-lived conversation in the UI after a work item
closes without placing transcript contents or lifecycle bookkeeping in the
event journal.

## Configuration

`config.yaml` gains a strict top-level `transcripts` section:

```yaml
transcripts:
  enabled: false
  retentionMs: 86400000
```

`enabled` defaults to `false`. When omitted, `retentionMs` defaults to 24
hours. `retentionMs: 0` removes a work item's captured transcripts when its
workspace is cleaned after closure. The removed legacy
`retainAfterWorkspaceCleanup` key remains invalid.

## Artifact layout

Transcript artifacts live outside the journal and projections at:

```text
.wake/transcripts/<work-item-id>/
  session--<safe-cli>--<safe-session-id>/
    <timestamp>.<run-id>.prompt.txt
    <timestamp>.<run-id>.response.txt
  run--<safe-run-id>/
    <timestamp>.<run-id>.prompt.txt
    <timestamp>.<run-id>.response.txt
```

The parent directory is a typed conversation-group key, never an ambiguous
value that is sometimes a session ID and sometimes a run ID. A runner that
returns an opaque session ID uses a `session--` directory scoped by CLI and
session ID. A runner with no session ID uses a `run--` directory containing
only that run's conversation. Each file has a UTC, lexically sortable
timestamp, the source run ID, and `prompt` or `response` type.

The prompt is captured before runner invocation. Capture first uses a private
per-run staging location. Once the runner returns, Wake finalises the staged
prompt and response into the session group returned by that runner. If the
runner returns no session ID, Wake finalises them into the run group. Failed
runner execution still finalises the prompt and any available raw response in
the run group.

## Execution and retention lifecycle

The composed Execution boundary owns transcript capture. It writes the exact
rendered prompt supplied to the runner and the raw response text returned by
the runner. Capture is enabled only through configuration; no event is
appended for writing, finalising, reading, expiry marking, or deleting a
transcript.

The existing close/workspace-cleanup lifecycle owns retention. When it cleans
a closed work item's workspace, it writes a filesystem-only `.cleaned-at`
timestamp in that work item's transcript directory, or deletes that directory
immediately for zero retention. A regular maintenance pass scans only marked
directories and deletes those whose cleanup timestamp has reached the configured
retention interval. Open work items are never expired by this sweep.

Transcript I/O errors are operational diagnostics: they are logged and do not
change a Run's outcome, a work item's state, or the success/failure of normal
workspace cleanup.

## API and UI

The transcript endpoint takes a run ID and uses the existing durable Run view
as an index to its work item and session metadata. It reads only the matching
filesystem conversation group; it does not replay events or store transcript
contents in projections. The response returns ordered entries with timestamp,
channel, text, source run ID, and group identity.

The Run detail UI defaults to a conversation view for the selected session
group. It presents chronological prompt/response entries as a chat, with
visible run separators or source-run labels. A run-only filter is available,
so an operator can inspect just the selected run even when it resumed an
existing CLI session. A missing, expired, or disabled transcript is shown as
unavailable.

## Tests and documentation

Tests prove configuration defaults and validation, disabled capture, exact
prompt-before-response capture, session and run fallback grouping, ordered API
retrieval, run-only filtering, post-close 24-hour retention, zero retention,
and non-fatal filesystem failures. The configuration and execution reference
documentation describe the feature as current behavior and remove the deferred
implementation statement.
