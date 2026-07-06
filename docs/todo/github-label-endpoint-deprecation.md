Found while running the Docker sandbox against live GitHub traffic.

Wake currently updates status labels through the generic issue-update REST path,
which emits an Octokit deprecation warning like:

`[@octokit/request] "PATCH https://api.github.com/repos/<owner>/<repo>/issues/<n>" is deprecated`

Root cause:
- `src/adapters/github/github-client.ts` implements `setLabels()` with
  `octokit.rest.issues.update({ labels })`
- Wake only needs label replacement there, not general issue mutation

Follow-up:
- switch `setLabels()` to the dedicated label endpoint
  `octokit.rest.issues.setLabels(...)`
- keep behavior the same: replace only the `wake:status.*` label family while
  preserving unrelated labels
- add or update adapter tests so the route swap is covered

Why this matters:
- current behavior still works, but it produces noisy runtime warnings
- the warning says the route is scheduled for removal on 2028-03-10
