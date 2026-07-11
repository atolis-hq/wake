export const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Wake control plane</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark light; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #14161a; color: #e8e8e8; }
  header { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 1rem; background: #1d2026; border-bottom: 1px solid #2c313a; flex-wrap: wrap; }
  header h1 { font-size: 1rem; margin: 0; font-weight: 600; }
  .pill { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .pill-idle { background: #1f3d2c; color: #7fe3a3; }
  .pill-ticking { background: #1f3350; color: #7fb3ff; }
  .pill-paused { background: #4a3510; color: #ffcf7f; }
  nav { display: flex; gap: 0.25rem; padding: 0.5rem 1rem; background: #191c22; border-bottom: 1px solid #2c313a; }
  nav button { background: none; border: none; color: #9aa2ad; padding: 0.4rem 0.8rem; cursor: pointer; border-radius: 6px; font-size: 0.85rem; }
  nav button.active { background: #262b33; color: #fff; }
  main { padding: 1rem; }
  .columns { display: grid; grid-template-columns: repeat(6, minmax(180px, 1fr)); gap: 0.6rem; overflow-x: auto; }
  .col { background: #1a1d23; border-radius: 8px; padding: 0.5rem; min-height: 200px; }
  .col h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #9aa2ad; margin: 0.2rem 0.4rem 0.5rem; }
  .card { background: #22262e; border: 1px solid #2c313a; border-radius: 6px; padding: 0.5rem; margin-bottom: 0.5rem; cursor: pointer; font-size: 0.8rem; }
  .card:hover { border-color: #4d5866; }
  .card .title { font-weight: 600; margin-bottom: 0.25rem; }
  .card .meta { color: #9aa2ad; font-size: 0.72rem; }
  .chip { display: inline-block; background: #2c313a; border-radius: 4px; padding: 0.05rem 0.35rem; font-size: 0.68rem; margin-right: 0.2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #2c313a; }
  th { color: #9aa2ad; font-weight: 600; }
  pre { background: #1a1d23; padding: 0.75rem; border-radius: 6px; overflow: auto; font-size: 0.75rem; }
  .drawer { position: fixed; top: 0; right: 0; width: min(560px, 100%); height: 100%; background: #191c22; border-left: 1px solid #2c313a; overflow-y: auto; padding: 1rem; transform: translateX(100%); transition: transform 0.15s ease; }
  .drawer.open { transform: translateX(0); }
  .drawer .close { float: right; cursor: pointer; color: #9aa2ad; }
  .tiles { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .tile { background: #1a1d23; border-radius: 8px; padding: 0.6rem 0.9rem; min-width: 120px; }
  .tile .n { font-size: 1.3rem; font-weight: 700; }
  .tile .l { color: #9aa2ad; font-size: 0.72rem; text-transform: uppercase; }
  .amber { color: #ffcf7f; }
  .red { color: #ff8f7f; }
  .ok { color: #7fe3a3; }
  input[type=text] { background: #1a1d23; border: 1px solid #2c313a; color: #e8e8e8; padding: 0.3rem 0.5rem; border-radius: 6px; margin-bottom: 0.6rem; width: 260px; }
</style>
</head>
<body>
<header>
  <h1>Wake control plane</h1>
  <span id="loop-pill" class="pill">…</span>
  <span id="status-summary" class="meta"></span>
</header>
<nav>
  <button data-view="board" class="active">Board</button>
  <button data-view="activity">Activity</button>
  <button data-view="runs">Runs</button>
  <button data-view="config">Config</button>
  <button data-view="health">Health</button>
</nav>
<main id="main"></main>
<div id="drawer" class="drawer"><span class="close" id="drawer-close">close ✕</span><div id="drawer-body"></div></div>
<script>
const API = '/api/v1';
const CONDITIONS = ['needs-human', 'active', 'ready', 'waiting', 'stalled', 'finished'];
let currentView = 'board';

async function getJson(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

function fmtMs(ms) {
  if (ms === undefined || ms === null) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children || []) node.appendChild(child);
  return node;
}

async function renderStatusBar() {
  try {
    const status = await getJson('/status');
    const pill = document.getElementById('loop-pill');
    pill.textContent = status.loopState;
    pill.className = 'pill pill-' + status.loopState;
    const freshness = status.sourceFreshness.level;
    const summary = document.getElementById('status-summary');
    summary.textContent =
      'runs today: ' + status.runsToday + ' · failures today: ' + status.failuresToday +
      ' · source freshness: ' + freshness +
      (status.lastRun ? ' · last run: ' + status.lastRun.repo + '#' + status.lastRun.issueNumber + ' ' + status.lastRun.action + ' → ' + (status.lastRun.sentinel ?? status.lastRun.status) : '');
  } catch (err) {
    document.getElementById('status-summary').textContent = 'status unavailable: ' + err.message;
  }
}

async function renderBoard() {
  const board = await getJson('/board');
  const main = document.getElementById('main');
  main.innerHTML = '';
  const columns = el('div', { class: 'columns' }, CONDITIONS.map((cond) => {
    const items = board.filter((c) => c.condition === cond);
    const cards = items.map((item) => el('div', {
      class: 'card',
      onclick: () => openItem(item.repo, item.number),
    }, [
      el('div', { class: 'title', text: item.repo + '#' + item.number + ' ' + item.title }),
      el('div', { class: 'meta' }, [
        el('span', { class: 'chip', text: item.stage }),
        document.createTextNode(fmtMs(item.timeInStageMs) + ' in stage'),
      ]),
      el('div', { class: 'meta', text: item.lastRunSentinel ? 'last: ' + item.lastRunAction + ' → ' + item.lastRunSentinel : item.conditionReason }),
    ]));
    return el('div', { class: 'col' }, [
      el('h2', { text: cond + ' (' + items.length + ')' }),
      ...cards,
    ]);
  }));
  main.appendChild(columns);
}

async function openItem(repo, number) {
  const drawer = document.getElementById('drawer');
  const body = document.getElementById('drawer-body');
  body.innerHTML = 'Loading…';
  drawer.classList.add('open');
  const detail = await getJson('/items/' + encodeURIComponent(repo) + '/' + number);
  if (!detail) { body.textContent = 'Not found'; return; }
  body.innerHTML = '';
  body.appendChild(el('h2', { text: repo + '#' + number }));
  body.appendChild(el('p', { text: detail.item.issue.title }));
  body.appendChild(el('p', { class: 'meta', text: 'stage: ' + detail.item.wake.stage + (detail.item.wake.sessionId ? ' · session: ' + detail.item.wake.sessionId : '') }));
  if (detail.item.wake.workspacePath) {
    body.appendChild(el('p', { class: 'meta', text: 'workspace: ' + detail.item.wake.workspacePath }));
  }
  body.appendChild(el('h3', { text: 'Runs' }));
  const runsTable = el('table', {}, [
    el('tr', {}, ['action', 'status', 'sentinel', 'started', 'runId'].map((h) => el('th', { text: h }))),
    ...detail.runs.map((r) => el('tr', {}, [
      el('td', { text: r.action }), el('td', { text: r.status }), el('td', { text: r.sentinel || '' }),
      el('td', { text: r.startedAt }), el('td', { text: r.runId }),
    ])),
  ]);
  body.appendChild(runsTable);
  body.appendChild(el('h3', { text: 'Context' }));
  body.appendChild(el('pre', { text: JSON.stringify(detail.item.context, null, 2) }));
  body.appendChild(el('h3', { text: 'Recent events' }));
  body.appendChild(el('pre', { text: JSON.stringify(detail.events, null, 2) }));
}

async function renderActivity() {
  const events = await getJson('/events?limit=200');
  const main = document.getElementById('main');
  main.innerHTML = '';
  const table = el('table', {}, [
    el('tr', {}, ['time', 'direction', 'type', 'work item'].map((h) => el('th', { text: h }))),
    ...events.map((ev) => el('tr', {}, [
      el('td', { text: ev.ingestedAt }), el('td', { text: ev.direction }),
      el('td', { text: ev.sourceEventType }), el('td', { text: ev.workItemKey }),
    ])),
  ]);
  main.appendChild(table);
}

async function renderRuns() {
  const runs = await getJson('/runs');
  const main = document.getElementById('main');
  main.innerHTML = '';
  const table = el('table', {}, [
    el('tr', {}, ['repo#issue', 'action', 'status', 'sentinel', 'started', 'finished'].map((h) => el('th', { text: h }))),
    ...runs.map((r) => el('tr', {}, [
      el('td', { text: r.repo + '#' + r.issueNumber }), el('td', { text: r.action }), el('td', { text: r.status }),
      el('td', { text: r.sentinel || '' }), el('td', { text: r.startedAt }), el('td', { text: r.finishedAt || '' }),
    ])),
  ]);
  main.appendChild(table);
}

async function renderConfig() {
  const data = await getJson('/config');
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.appendChild(el('h3', { text: 'Routing table' }));
  main.appendChild(el('table', {}, [
    el('tr', {}, ['stage', 'action', 'tier', 'runner', 'model'].map((h) => el('th', { text: h }))),
    ...data.routingTable.map((r) => el('tr', {}, [
      el('td', { text: r.stage }), el('td', { text: r.action || '' }), el('td', { text: r.tier || '' }),
      el('td', { text: r.runnerName || '' }), el('td', { text: r.model || '' }),
    ])),
  ]));
  main.appendChild(el('h3', { text: 'Effective config (redacted)' }));
  main.appendChild(el('pre', { text: JSON.stringify(data.config, null, 2) }));
}

async function renderHealth() {
  const health = await getJson('/health');
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.appendChild(el('div', { class: 'tiles' }, [
    tile('Tick lock', health.lock.present ? (health.lock.stale ? 'stale' : 'held') : 'free'),
    tile('Paused', String(health.pause.paused)),
    tile('Integrity issues', String(health.integrityIssues.length)),
  ]));
  main.appendChild(el('h3', { text: 'Storage' }));
  main.appendChild(el('pre', { text: JSON.stringify(health.storage, null, 2) }));
  main.appendChild(el('h3', { text: 'Source polling' }));
  main.appendChild(el('pre', { text: JSON.stringify(health.sources, null, 2) }));
  main.appendChild(el('h3', { text: 'Integrity issues' }));
  main.appendChild(el('pre', { text: JSON.stringify(health.integrityIssues, null, 2) }));
}

function tile(label, value) {
  return el('div', { class: 'tile' }, [el('div', { class: 'n', text: value }), el('div', { class: 'l', text: label })]);
}

const renderers = { board: renderBoard, activity: renderActivity, runs: renderRuns, config: renderConfig, health: renderHealth };

function switchView(view) {
  currentView = view;
  for (const btn of document.querySelectorAll('nav button')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  renderers[view]();
}

for (const btn of document.querySelectorAll('nav button')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
}
document.getElementById('drawer-close').addEventListener('click', () => {
  document.getElementById('drawer').classList.remove('open');
});

renderStatusBar();
switchView('board');
setInterval(() => {
  renderStatusBar();
  renderers[currentView]();
}, 7000);
</script>
</body>
</html>
`;
