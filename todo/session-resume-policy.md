# Wire actual session resume vs fresh-start policy

`docs/implementation.md` lists "Resume vs fresh session" as a routing
decision Wake should make, but today every stage run starts a brand new
`claude -p` session - `session_id` is recorded in run records and surfaced
in GitHub comments for a human to resume manually, but Wake itself never
calls `claude --resume <session_id>`.

The `resume` prompt variants in `prompts/*.resume.md` already exist
(`src/adapters/claude/prompt-templates.ts` / `claude-runner.ts`'s
`buildStagePrompt` accepts `mode: 'resume'`), but nothing in
`tick-runner.ts` or `claude-runner.ts` ever passes `mode: 'resume'` or adds
`--resume <id>` to the CLI invocation - it's always `'start'`.

When picked up:
- Decide when to resume vs start fresh (e.g. same issue + same action +
  prior `sessionId` present and stage didn't regress) per the policy note
  in docs/implementation.md.
- Add `--resume <sessionId>` to `buildClaudePrintArgs` (or a variant) when
  resuming.
- Pass `mode: 'resume'` into `buildStagePrompt` in that case so the lighter
  resume templates are used instead of the full-context start templates.
