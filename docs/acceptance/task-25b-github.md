# Task 25B: manual real-GitHub acceptance

This is a human-run acceptance procedure. Do not run it in CI or with a token
recorded in the repository. Use a disposable repository and provide the token
through the approved local environment mechanism.

1. Create a disposable repository, set `GITHUB_TOKEN` locally, and configure one
   `integrations.github` instance for that repository. Record the redacted config
   shape, Wake revision, repository URL, and timestamp in the review evidence.
2. Create an eligible issue. Run Wake until idle and verify the public WorkItem
   view identifies the issue and selects the configured workflow.
3. Update the issue, then run Wake again. Verify the same Resource and WorkItem
   advance rather than a duplicate being created. Repeat one poll without a
   provider change and verify no duplicate event or work is created.
4. Verify Wake status, stage, and workflow labels are reconciled while an
   unrelated human label remains. Add a Wake marker comment or label and verify
   the next poll suppresses it as an echo.
5. Run one configured agent workflow. Record its Run view, including runner,
   model/effort where configured, session and token/cost fields where reported,
   and transcript availability.
6. On a disposable pull request, submit the configured human review/comment
   decision. Verify Wake accepts only that current human decision and records
   the expected workflow transition.
7. Trigger one intended outbound effect (reply, status comment, approval, or
   merge as appropriate). Verify the GitHub effect contains the Wake delivery
   marker and that retrying the same durable intent does not create another
   effect.
8. Record each command, expected public view, observed result, and any failure.
   A failure returns to Task 25B for correction; a passing fake-provider suite
   does not waive this manual evidence.
