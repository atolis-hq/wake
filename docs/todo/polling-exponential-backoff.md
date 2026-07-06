Found while tracing resident-loop responsiveness and polling behavior.

Wake's resident loop currently sleeps for one fixed `scheduler.intervalMs`
between ticks. There is no adaptive polling policy for idle periods, repeated
errors, or bursts of fresh activity.

Desired behavior:
- replace the fixed-only polling cadence with an exponential backoff policy
- support configurable minimum and maximum poll intervals
- reset back to the minimum interval when new relevant activity is detected
- back off gradually when ticks remain idle
- define how repeated poll errors should affect the backoff state

Why this matters:
- a low fixed interval is responsive but noisy and wasteful when nothing is
  happening
- a high fixed interval is cheap but makes Wake feel stalled until the next
  scheduled tick
- the loop should adapt to real activity instead of forcing one global tradeoff

Follow-up:
- design the backoff state model in the control plane
- decide whether backoff applies to all ticks or only GitHub polling
- expose config for minimum/maximum interval and any reset/backoff multiplier
- update docs/tests so operator expectations match the real runtime behavior
