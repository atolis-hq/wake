# Builder Notes — non-obvious details for the implementing model

Read [`vision.md`](vision.md) and [`implementation.md`](implementation.md) first;
they are authoritative. This file is only the traps and nuances that are easy to
miss and expensive to discover. Do not re-litigate decisions recorded there.

## Traps that will silently break the system

1. **One GitHub account, two authors.** The worker and the human comment as the
   *same* account. Any logic keyed on comment author (unblock detection,
   `/pause`-style commands later) is dead on arrival. Every Wake-authored
   comment must embed `<!-- wake -->`; "human replied" = latest comment lacks
   the marker. Test this first — it gates the whole blocked→queue flow.
2. **Sentinel drift.** Models pad output after the sentinel. Match the last
   occurrence of `DONE|BLOCKED|FAILED` in the JSON `result` string; absent
   sentinel = FAILED. Never regex the raw stdout — use
   `--output-format json` and parse the object (stderr may interleave).
3. **Usage-limit errors are not a documented shape.** Capture a real one before
   writing the parser (spike #1). Expect it to change; the parser must degrade
   to "back off 5h" rather than crash the tick.
4. **`claude --resume` in headless mode is unverified** for the
   stage-B-resumes-stage-A pattern (spike #2). Build the runner so resume is a
   flag on the invocation, not a structural assumption — if the spike fails,
   fresh-session-always must be a config change, not a rewrite.
5. **Credentials in the container.** Claude Code stores OAuth creds under
   `~/.claude` (file-based on Linux — good; no keychain inside a container).
   Mount `~/.claude` from the volume. Do not mount host `~/.config/gh` by
   default; that would make the sandbox reuse the host GitHub identity.
   First login must be done interactively via `docker exec`. Verify Claude
   auth survives container *recreation*, not just restart, and authenticate
   GitHub separately inside the sandbox if Wake needs it there.
6. **Windows host filesystem.** Bind-mounting NTFS into the container makes
   `npm install` and git 5–20× slower and breaks some file modes. Use a named
   volume or WSL2-native path. Set `TZ` in the container or quiet hours run on
   UTC.

## Design intents that are easy to get subtly wrong

- **Wake decides, the agent runs.** Never let the runner prompt ask the agent
  to choose models, label issues, or move state. The agent's only outputs are
  code/PR/comments and the sentinel. All labels and state transitions are
  applied by the control plane after parsing the result.
- **The tick is a pure function of durable state.** Each tick: read
  `~/.wake/` + GitHub → decide → act → persist. No decision may depend on
  process memory. If you find yourself caching "what happened last tick" in a
  variable, put it in a file instead. This is what makes crash/restart free.
- **Crash-safe run claim.** Write the run record (status `running`, started-at)
  *before* invoking the CLI. On startup, any `running` record older than the
  wall-clock timeout is a failed attempt. This replaces any in-memory lock.
- **Refine is cheap by construction:** no workspace, `--max-turns ~10`, batched.
  If refine ever needs `npm install`, the design is wrong — it reads the issue
  and the canonical clone read-only.
- **Don't auto-escalate model on retry.** A failed attempt means a bad spec →
  that's what BLOCKED is for. Escalation is per-issue opt-in only.
- **GitHub is half the state.** Labels can be edited by the human at any time;
  reconcile labels→local state at the start of every tick and treat GitHub as
  the winner for *stage*, local files as the winner for *history/attempts*.

## Sequencing advice

- Do spikes 1–3 (limit-error shape, headless resume, container creds) before
  writing more than the skeleton — each can invalidate an interface.
- Build with a **fake runner** (a script that prints a canned JSON result with
  a chosen sentinel) so the whole lifecycle is testable with zero tokens; keep
  it forever as the test harness.
- Pull the baseline health gate (skip implement when `main` is red) in as soon
  as the implement stage exists — it is a few lines and prevents the single
  most wasteful failure mode.
- `--max-turns` and the wall-clock timeout on *every* invocation from day one.
  These are the only runaway protections; they are free; never omit them.
