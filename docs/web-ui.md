# Web UI

The default page is Board. A single header contains the Wake brand, version,
and dispatch controls. Paused models appear in the dispatch dropdown.

The sidebar contains Board, Work items, and Runs, followed by work items grouped
by status. Finished starts collapsed; the other groups start expanded. Search
matches resource IDs and titles, and sorting supports recent activity or title.
The selected work item is highlighted. Events, Analytics, Config, and Health
remain available at the bottom.

Drag the sidebar divider to resize it, or focus the divider and use the arrow
keys. Width and the desktop collapsed preference are remembered in the browser.
On mobile, the header toggle opens a navigation drawer. Escape or the backdrop
closes it, and selecting a page dismisses it automatically.

Board cards and sidebar items open the work item in the main panel. Its tabs
are Overview, Runs, Events, Transcripts, and Conversation. The overview places
work details and actions above the full-width workflow, followed by an activity
timeline and resource links. Narrow screens place resources immediately after the work details, then the
workflow and activity timeline. The workflow retains its mobile card presentation.

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
