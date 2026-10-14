# Web UI

The default page is Board. A single header contains the Wake brand, version,
and dispatch controls. Paused models appear in the dispatch dropdown.

The sidebar contains Board, Work items, Runs, and Triggers, followed by work items grouped
by status. Finished starts collapsed; the other groups start expanded. Search
matches resource IDs and titles, and sorting supports recent activity or title.
The selected work item is highlighted. Events, Analytics, Config, and Health
remain available at the bottom.

Drag the sidebar divider to resize it, or focus the divider and use the arrow
keys. Width and the desktop collapsed preference are remembered in the browser.
On mobile, the header toggle opens a navigation drawer. Escape or the backdrop
closes it, and selecting a page dismisses it automatically.

Board cards and sidebar items open the work item in the main panel. Its tabs
are Overview, Runs, Artifacts, Events, Transcripts, and Conversation. The
Artifacts tab lists the latest accepted revision from each producing stage;
each path is an authorized Wake download rather than a provider-hosted file.
The overview places
work details and actions above the full-width workflow, followed by an activity
timeline and resource links. Narrow screens place resources immediately after the work details, then the
workflow and activity timeline. The workflow retains its mobile card presentation.

Eligible blocked agent work exposes **Continue with instructions**. The authenticated API supplies
`conversation.canContinue` from orchestration policy and WorkItem availability. The action opens
the Conversation composer, requires instructions, and sends `/changes` with those instructions
through `POST /api/v1/work-items/:workItemKey/commands/message` with `continuation: true`. Messaging must be enabled.
The ordinary authenticated operator composer retains `/approved` and `/accepted` for human workflow
waits; ordinary `/changes` follows the wait's rejection route. Explicit Continue reenters the eligible
agent stage without accepting a review signal. Plain comments leave successful review waits intact.
Failed-stage **Retry** remains a separate action. A rejected command returns a conflict with its
reason; the composer keeps the instructions for correction. Continuation grants no independent
review, approval, or merge authority. Frozen, deleted, and closed work cannot continue.

## Triggers

Triggers lists configured definitions and retained operational/history identities,
with effective status, workflow, next cron occurrence in UTC, latest invocation,
and pause/failure and skip reasons. Events-only triggers have no next scheduled
time. Detail shows the current definition, pending sources, latest actual skipped
source/time/reason, and invocation history linked to independent WorkItems.
WorkItem detail links back to its trigger origin. Removed definitions retain
recorded history; they do not start future invocations.

Pause and resume are available on both views. They use the owning Control Plane
commands and never rewrite configuration. Pause clears unstarted pending work;
active invocations continue. Cancel/freeze remains on WorkItem pages. Resume
allows future explicit sources without starting work or resetting retries.
Unavailable definitions and permission/command errors are shown explicitly.
Shared context links are not exposed until the owning context capability exists.

Authenticated API routes are `GET /api/v1/triggers`,
`GET /api/v1/triggers/:triggerId`, and
`POST /api/v1/triggers/:triggerId/commands/pause` or `resume`.
Commands accept only `{ "idempotencyKey": "..." }` and use the same durable
start/pause lock as the engine. Unknown identities return missing/conflict
responses; removed identities with retained history remain inspectable.

## Styling

`src/surfaces/web/src/styles/palette.css` defines raw colors. `tokens.css` maps
those colors to semantic roles and defines shared spacing, typography, radii,
and shell dimensions. Components consume semantic tokens; future themes can
override those tokens without changing component markup. Theme selection is
not currently exposed in the UI.

## Development preview with a remote API

Run the local UI against an existing Wake server in PowerShell:

```powershell
$env:WAKE_UI_API_TARGET = 'https://wake.example.com'
npm --workspace @atolis-hq/wake-web run dev
```

Open `http://localhost:5173` and sign in using a temporary login code generated
by that remote server. The development server proxies `/api` to the selected
server, including authentication. Your existing login on the remote hostname
is separate from the localhost session. This uses real remote data and actions.

Without `WAKE_UI_API_TARGET`, the development proxy uses `http://127.0.0.1:4317`.
The proxy is development-only and does not change packaged production assets.

The Conversation tab uses a dedicated message history and bottom composer. It
opens at the latest message and follows new messages while you are at the
bottom. Scrolling up preserves your reading position; Jump to latest returns
to the newest message. Messages are presented oldest to newest.

Configuration and Health keep their refresh controls inside the selected tab.
Health has Overview, Adapter health, Runner availability, and Maintenance
recovery sections. On mobile, tables display as labelled rows; long IDs and
transcript content wrap within the available width.

Conversation shows each participant's identity and source in a thread layout.
The history scrollbar stays at the panel edge while messages and the composer
remain centred. Work details are hidden on Conversation and Transcripts.

## Analytics

Analytics has **Reports** and **System activity** tabs. System activity retains
today's event, work-item and run counters from the existing analytics projection.
Reports offers 1d, 3d, 5d and 7d windows, a report selector, and summary tiles.
The initial report is run outcomes over time, with stacked outcome buckets,
overall status totals, and an expandable bucket table.

Tiles and the selected report load independently, each with loading, error and
retry states. Changing the window or report cancels obsolete requests. Empty
counts and usage totals are zero; medians without qualifying data show
**No data**. Costs are in USD and durations are shown in seconds.

The 1d and 3d windows are rolling periods with hourly and 6-hour UTC buckets,
including partial boundary buckets. The 5d and 7d windows use preceding complete
UTC days. Runs belong to their start-time cohort and show their latest known
outcome. Work items done count first primary workflow completion in the window;
end-to-end duration starts at work creation. See [Analytics API](analytics-api.md)
for metric definitions, usage handling, response shapes, and report registration.

Policy-blocked merge waits show **Waiting for human merge** in work details,
with the applicable protected paths and matching changed paths, or the configured
file-count limit and observed count. The correlated PR link and next action
explain that manual merge resolves the wait; approval or comments do not override
merge policy. Older outcomes use the pinned workflow restriction when available.
After the PR merges, the status becomes **PR merged; recovery pending**, with
advancement guidance. The usual workflow/work state shows completion afterward.
The work-detail API exposes this explanation as `orchestration.primary.mergePolicyBlock`;
only applicable merge restrictions are included.

The trigger detail page includes **Operator standing instructions** for its explicit contextScope. All triggers with that scope share the document. Edit Markdown, preview it with the same HTML-disabled rendering as the artifact viewer, and save it for later runs. Conflicting saves preserve the draft and offer an explicit reload of current instructions. Triggers without a scope show a configuration message and no editor. Run details show the scope and immutable instructions revision (or absence) received at run start.
