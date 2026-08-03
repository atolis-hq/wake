# Next Agent-Run GitHub Publication Design

## Goal

Make Next publish one legacy-compatible GitHub comment for every terminal agent run by default, including successful, rejected, blocked, failed, and infrastructure-failed runs.

## Boundary

Execution remains provider-neutral. The generic execution run model remains agnostic to activity kind. When a run is an agent run, its result carries an optional typed `agent` value; the execution agent adapter owns runner-protocol parsing and constructs that value with a constrained metadata bag for runner-specific scalar facts. A generic terminal agent-run report projection joins typed execution, orchestration, and resource-correlation facts into a reusable report view. An integrations-layer reactor consumes that report and emits a structured agent-run publication intent for the run's primary commentable resource. The GitHub adapter only renders that structured intent into the GitHub-specific Wake comment and delivers it through the existing idempotent delivery service.

## Data flow

1. An agent run records `execution.run-started`, including resolved runner identity, pool, model, workspace, and start time.
2. For an agent run, the execution agent adapter parses runner output once into the optional typed `agent` result value: evaluated outcome, display body, optional artifacts, and a `metadata` bag of JSON-safe scalar key/value facts for runner-specific information. Raw protocol output remains private to the runner/agent adapter and is not emitted outside execution.
3. It records the typed response with runner/session/usage/cost metadata, and a terminal run event records the final outcome or infrastructure failure and finish time.
4. The generic report projection joins those facts by run ID, resolves stage and primary resource correlation, and exposes a terminal report view.
5. The publication reactor appends exactly one structured agent-run publication intent using the run ID as its idempotency key.
6. Existing delivery projects, retries, and routes the intent. The GitHub adapter renders the Wake marker/header/outcome/body/footer before calling GitHub.

## Comment semantics

The generic report exposes `displayBody`, never raw runner JSON. The execution agent adapter ports the legacy `wake-result` fenced-envelope and final-sentinel rules: it strips the machine envelope/sentinel, preserves the prose response, and synthesizes readable text when a valid structured envelope has no prose. Raw protocol output is retained only within the runner/agent adapter boundary and is not emitted as an execution, integration, or delivery fact. The evaluated outcome supplies the displayed outcome and optional instruction footer:

- `DONE`: Done; no instruction footer unless a resumable session exists.
- `REJECTED`: Changes Requested.
- `BLOCKED`: Blocked, with the reply-to-continue footer.
- `FAILED`: Failed, including runner and infrastructure failures.

The generic report contains strongly typed run ID, activity, status, timing, workspace, and primary resource when known. For agent runs only, it has `agent?: AgentRunReport` containing stage, named runner, runner pool, CLI kind, model, token total, cost, display body, evaluated outcome, session, artifacts, and `metadata: Readonly<Record<string, string | number | boolean | null>>`. Non-agent runs omit `agent` entirely. The GitHub formatter adds the durable Wake/idempotency markers used to suppress provider echoes and duplicate posts.

## Configuration

Publication is enabled by default for GitHub-backed commentable resources. This change adds no configuration surface. A later configuration feature may disable publication or customize headers/footers.

## Failure and idempotency

The reactor is checkpointed and idempotent by run ID. It must publish once after all required facts are available, retry through the existing delivery service on transient GitHub errors, and never prevent workflow advancement. Missing optional metadata is omitted. A runner failure without a response still produces a Wake failure comment using the recorded failure message as its body.

## Testing

Execution agent-adapter parser tests cover structured JSON, degraded sentinels, malformed output, synthesized display text, and metadata normalization; generic run-model tests prove non-agent runs omit the agent value; contract tests prove raw protocol output cannot escape execution. Projection tests cover joining and terminal report shape for every outcome and missing runner response. Reactor tests cover one structured intent per report and non-GitHub neutrality. GitHub formatter tests cover every outcome and optional metadata; delivery tests cover the resulting comment payload and idempotency. An end-to-end test exercises a fake agent result through the full pipeline.