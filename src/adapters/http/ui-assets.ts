import { wakeVersion } from '../../version.js';

const logoSvg = `<svg viewBox="0 0 110 110" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(55 55)">
    <circle r="54" fill="none" stroke="#0F766E" opacity=".10"></circle>
    <path d="M-42.5-11.5 A44 44 0 1 0 42.5-11.5" fill="none" stroke="#2DD4BF" stroke-width="7.5" stroke-linecap="round"></path>
    <path d="M-36-25.2 A44 44 0 0 1-25.2-36" fill="none" stroke="#5EEAD4" stroke-width="7.5" stroke-linecap="round"></path>
    <path d="M25.2-36 A44 44 0 0 1 36-25.2" fill="none" stroke="#5EEAD4" stroke-width="7.5" stroke-linecap="round"></path>
    <circle r="25" fill="#2DD4BF" opacity=".08"></circle>
    <circle r="11" fill="#2DD4BF" opacity=".25"></circle>
    <path d="M-18 23 C-9 22 -8 2 0-2 C8 2 9 22 18 23" fill="none" stroke="#2DD4BF" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
  </g>
</svg>`;

const faviconHref = `data:image/svg+xml,${encodeURIComponent(logoSvg)}`;

export const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Wake control plane</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: dark light;
    --brand: #0f766e;
    --brand-dark: #134e4a;
    --brand-darker: #103a37;
    --accent: #2dd4bf;
    --accent-light: #5eead4;
  }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #14161a; color: #e8e8e8; }
  .topbar { display: flex; align-items: center; gap: 0.55rem; padding: 0.55rem 1rem; background: var(--brand); }
  .topbar .logo { display: flex; width: 24px; height: 24px; flex-shrink: 0; }
  .topbar .logo svg { width: 100%; height: 100%; display: block; }
  .topbar .brand-name { font-size: 1.05rem; font-weight: 700; color: #fff; letter-spacing: 0.01em; }
  .topbar .version { color: rgba(255, 255, 255, 0.7); font-size: 0.78rem; }
  .statusbar { display: flex; align-items: center; gap: 1rem; padding: 0.45rem 1rem; background: var(--brand-dark); border-top: 1px solid rgba(0, 0, 0, 0.18); flex-wrap: wrap; font-size: 0.8rem; }
  .statusbar .meta { color: rgba(255, 255, 255, 0.72); }
  .statusbar button { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); color: #fff; border-radius: 6px; padding: 0.22rem 0.55rem; cursor: pointer; font-size: 0.78rem; }
  .statusbar button:hover:not(:disabled) { border-color: var(--accent-light); background: rgba(45, 212, 191, 0.16); }
  .statusbar button:disabled { cursor: wait; opacity: 0.62; }
  .pill { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
  .pill-idle { background: #1f3d2c; color: #7fe3a3; }
  .pill-polling { background: #1f3350; color: #7fb3ff; }
  .pill-working { background: #2d1f50; color: #c79bff; }
  .pill-paused { background: #4a3510; color: #ffcf7f; }
  nav { display: flex; gap: 0.25rem; padding: 0.4rem 1rem 0 0.3rem; background: var(--brand-darker); border-bottom: 1px solid #2c313a; }
  nav button { background: none; border: none; border-bottom: 2px solid transparent; color: rgba(255, 255, 255, 0.65); padding: 0.4rem 0.7rem 0.45rem; margin-bottom: -1px; cursor: pointer; font-size: 0.85rem; transition: color 0.12s ease; }
  nav button:hover { color: #fff; }
  nav button.active { color: var(--accent-light); border-bottom-color: var(--accent); }
  main { padding: 1rem; }
  .columns { display: grid; grid-template-columns: repeat(5, minmax(180px, 1fr)); gap: 0.6rem; overflow-x: auto; }
  .col { background: #1a1d23; border-radius: 10px; padding: 0.5rem; min-height: 200px; }
  .col h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #9aa2ad; margin: 0.2rem 0.4rem 0.5rem; }
  .card { background: #22262e; border: 1px solid #2c313a; border-radius: 8px; padding: 0.5rem; margin-bottom: 0.5rem; cursor: pointer; font-size: 0.8rem; transition: border-color 0.12s ease; }
  .card:hover { border-color: var(--accent); }
  .card .title { font-weight: 600; margin-bottom: 0.25rem; }
  .card .meta { color: #9aa2ad; font-size: 0.72rem; }
  .chip { display: inline-block; background: #2c313a; border-radius: 4px; padding: 0.05rem 0.35rem; font-size: 0.68rem; margin-right: 0.2rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #2c313a; }
  th { color: #9aa2ad; font-weight: 600; }
  pre { background: #1a1d23; padding: 0.75rem; border-radius: 6px; overflow: auto; font-size: 0.75rem; }
  .modal-overlay { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.58); padding: 1.25rem; z-index: 10; }
  .modal-overlay.open { display: flex; }
  .modal { width: calc(100vw - 3rem); height: calc(100vh - 3rem); background: #191c22; border: 1px solid #2c313a; border-radius: 8px; display: flex; flex-direction: column; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.85rem 1rem 0.55rem; border-bottom: 1px solid #2c313a; }
  .modal-header h2 { margin: 0; font-size: 1rem; }
  .modal .close { cursor: pointer; color: #9aa2ad; background: none; border: 0; font-size: 0.9rem; padding: 0.2rem 0; }
  .modal .close:hover { color: var(--accent-light); }
  .modal-tabs { display: flex; gap: 0.25rem; padding: 0 1rem; border-bottom: 1px solid #2c313a; }
  .modal-tabs .nav-button { background: none; border: none; border-bottom: 2px solid transparent; color: rgba(255, 255, 255, 0.65); padding: 0.45rem 0.7rem 0.5rem; margin-bottom: -1px; cursor: pointer; font-size: 0.85rem; }
  .modal-tabs .nav-button:hover { color: #fff; }
  .modal-tabs .nav-button.active { color: var(--accent-light); border-bottom-color: var(--accent); }
  .modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 1rem; }
  .modal-body h3:first-child { margin-top: 0; }
  .transcript-session { margin: 0.75rem 0; color: #9aa2ad; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.75rem; text-align: center; }
  .transcript-entry { background: #101216; border: 1px solid #2c313a; border-radius: 6px; margin-bottom: 0.75rem; overflow: hidden; }
  .transcript-head { color: #9aa2ad; background: #171a20; border-bottom: 1px solid #2c313a; padding: 0.45rem 0.6rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.72rem; }
  .transcript-text { white-space: pre-wrap; margin: 0; background: transparent; border-radius: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.76rem; }
  @media (max-width: 767px) {
    .modal-overlay { padding: 0; }
    .modal { width: 100%; height: 100%; max-height: none; border-radius: 0; border-left: 0; border-right: 0; }
  }
  .tiles { display: flex; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .tile { background: #1a1d23; border-radius: 10px; padding: 0.6rem 0.9rem; min-width: 120px; }
  .tile .n { font-size: 1.3rem; font-weight: 700; }
  .tile .l { color: #9aa2ad; font-size: 0.72rem; text-transform: uppercase; }
  .toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .toolbar label { display: inline-flex; align-items: center; gap: 0.35rem; color: #9aa2ad; font-size: 0.8rem; }
  select { background: #1a1d23; border: 1px solid #2c313a; color: #e8e8e8; padding: 0.3rem 0.5rem; border-radius: 6px; font-size: 0.8rem; }
  select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.15); }
  .metric-bar { width: 160px; height: 0.5rem; background: #101216; border-radius: 999px; overflow: hidden; }
  .metric-bar-fill { height: 100%; background: var(--accent); border-radius: 999px; }
  .stacked-bar { display: flex; width: min(520px, 45vw); min-width: 220px; height: 0.75rem; background: #101216; border-radius: 999px; overflow: hidden; }
  .stacked-segment { height: 100%; min-width: 1px; }
  .metric-table-value { display: flex; align-items: center; gap: 0.55rem; }
  .amber { color: #ffcf7f; }
  .red { color: #ff8f7f; }
  .ok { color: #7fe3a3; }
  input[type=text] { background: #1a1d23; border: 1px solid #2c313a; color: #e8e8e8; padding: 0.3rem 0.5rem; border-radius: 6px; margin-bottom: 0.6rem; width: 260px; transition: border-color 0.12s ease, box-shadow 0.12s ease; }
  input[type=text]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.15); }
  a { color: var(--accent-light); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .resource-list { list-style: none; padding: 0; margin: 0 0 1rem; }
  .resource-list li { display: flex; align-items: baseline; gap: 0.4rem; margin-bottom: 0.35rem; font-size: 0.8rem; }
  .btn { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); color: #fff; border-radius: 6px; padding: 0.22rem 0.55rem; cursor: pointer; font-size: 0.78rem; margin-top: 0.4rem; }
  .btn:hover:not(:disabled) { border-color: var(--accent-light); background: rgba(45, 212, 191, 0.16); }
  .btn:disabled { cursor: default; opacity: 0.62; }
</style>
</head>
<body>
<header class="topbar">
  <span class="logo">${logoSvg}</span>
  <span class="brand-name">Wake</span>
  <span class="version">${wakeVersion}</span>
</header>
<div class="statusbar">
  <span id="loop-pill" class="pill">…</span>
  <button id="force-tick" type="button">Tick now</button>
  <span id="status-summary" class="meta"></span>
</div>
<nav>
  <button data-view="board" class="active">Board</button>
  <button data-view="activity">Activity</button>
  <button data-view="runs">Runs</button>
  <button data-view="analytics">Analytics</button>
  <button data-view="config">Config</button>
  <button data-view="health">Health</button>
</nav>
<main id="main"></main>
<div id="modal-overlay" class="modal-overlay">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-header">
      <h2 id="modal-title"></h2>
      <button type="button" class="close" id="modal-close">close &#x2715;</button>
    </div>
    <div id="modal-tabs" class="modal-tabs"></div>
    <div id="modal-body" class="modal-body"></div>
  </section>
</div>
<script>
const API = '/api/v1';
const CONDITIONS = ['ready', 'active', 'needs-human', 'error', 'finished'];
let currentView = 'board';
let analyticsWindow = '7d';
let analyticsMetric = 'runs-over-time';
let activeViewRequest = null;
let activeViewRequestId = 0;

const METRIC_OPTIONS = [
  ['runs-over-time', 'Runs over time'],
  ['runs-by-status-over-time', 'Runs by status over time'],
  ['runs-by-status', 'Runs by status'],
  ['runs-by-action', 'Runs by action/stage'],
  ['runs-by-repo', 'Runs by repo'],
  ['runs-by-runner', 'Runs by runner'],
  ['runs-by-model', 'Runs by model'],
  ['runs-by-tier', 'Runs by tier'],
  ['tokens-over-time', 'Tokens over time'],
  ['tokens-by-action', 'Tokens by action/stage'],
  ['tokens-by-runner', 'Tokens by runner'],
  ['tokens-by-model', 'Tokens by model'],
  ['duration-by-action', 'Duration by action/stage'],
  ['duration-over-time', 'Duration over time'],
  ['work-items-over-time', 'Work items completed over time'],
  ['work-item-durations', 'Work item e2e duration'],
  ['work-item-totals', 'Work item totals'],
];

async function getJson(path, signal) {
  const res = await fetch(API + path, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

async function postJson(path) {
  const res = await fetch(API + path, { method: 'POST' });
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

function isActiveRequest(requestId) {
  return activeViewRequest && activeViewRequest.id === requestId;
}

function loadingNode(label) {
  return el('p', { class: 'meta', text: 'Loading ' + label + '...' });
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
      ' · cost today: $' + Number(status.costUsdToday ?? 0).toFixed(2) +
      ' · source freshness: ' + freshness +
      (status.lastRun ? ' · last run: ' + status.lastRun.repo + '#' + status.lastRun.issueNumber + ' ' + status.lastRun.action + ' → ' + (status.lastRun.sentinel ?? status.lastRun.status) : '');
  } catch (err) {
    document.getElementById('status-summary').textContent = 'status unavailable: ' + err.message;
  }
}

async function forceTickNow() {
  const button = document.getElementById('force-tick');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Requested';
  try {
    await postJson('/tick');
    await renderStatusBar();
  } catch (err) {
    document.getElementById('status-summary').textContent = 'tick request failed: ' + err.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
    }, 900);
  }
}

async function renderBoard(context) {
  const board = await getJson('/board', context.signal);
  if (!isActiveRequest(context.requestId)) return;
  const main = document.getElementById('main');
  main.innerHTML = '';
  const columns = el('div', { class: 'columns' }, CONDITIONS.map((cond) => {
    const items = board.filter((c) => c.condition === cond);
    const cards = items.map((item) => el('div', {
      class: 'card',
      onclick: () => openItemModal(item.repo, item.number),
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

function resourceUriToUrl(resourceUri) {
  const parts = resourceUri.split(':');
  if (parts.length < 3) return null;
  const provider = parts[0];
  const type = parts[1];
  const locator = parts.slice(2).join(':');
  const m = locator.match(/^(.+)#([0-9]+)$/);
  if (!m) return null;
  if (provider === 'github') {
    if (type === 'issue') return 'https://github.com/' + m[1] + '/issues/' + m[2];
    if (type === 'pr') return 'https://github.com/' + m[1] + '/pull/' + m[2];
  }
  return null;
}

async function openItemModal(repo, number) {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const tabs = document.getElementById('modal-tabs');
  const body = document.getElementById('modal-body');
  const loaded = new Map();
  body.textContent = 'Loading...';
  tabs.innerHTML = '';
  title.textContent = repo + '#' + number;
  overlay.classList.add('open');

  for (const tab of ['details', 'events', 'transcripts']) {
    tabs.appendChild(el('button', {
      type: 'button',
      class: 'nav-button',
      text: tab[0].toUpperCase() + tab.slice(1),
      onclick: () => switchItemTab(tab),
    }));
  }

  async function ensureDetail() {
    if (!loaded.has('detail')) {
      loaded.set('detail', await getJson('/items/' + encodeURIComponent(repo) + '/' + number));
    }
    return loaded.get('detail');
  }

  async function switchItemTab(tab) {
    for (const button of tabs.querySelectorAll('button')) {
      button.classList.toggle('active', button.textContent.toLowerCase() === tab);
    }
    body.scrollTop = 0;
    if (!loaded.has(tab)) {
      body.textContent = 'Loading...';
      loaded.set(tab, await renderItemTab(tab));
    }
    body.replaceChildren(loaded.get(tab));
    if (tab === 'transcripts') {
      body.scrollTop = body.scrollHeight;
    }
  }

  async function renderItemTab(tab) {
    const detail = await ensureDetail();
    if (!detail) return el('p', { text: 'Not found' });
    if (tab === 'events') {
      return el('div', {}, [el('pre', { text: JSON.stringify(detail.events, null, 2) })]);
    }
    if (tab === 'transcripts') {
      const transcripts = await getJson('/work-items/' + encodeURIComponent(detail.item.workItemKey) + '/transcripts');
      return renderTranscripts(transcripts);
    }
    return renderItemDetails(detail);
  }

  await switchItemTab('details');
}

function renderItemDetails(detail) {
  const body = el('div');
  const repo = detail.item.issue.repo;
  const number = detail.item.issue.number;
  const headLink = el('a', { href: detail.item.issue.url, target: '_blank', rel: 'noopener noreferrer', text: repo + '#' + number });
  body.appendChild(el('h3', {}, [headLink]));
  body.appendChild(el('p', { text: detail.item.issue.title }));
  body.appendChild(el('p', { class: 'meta', text: 'stage: ' + detail.item.wake.stage + (detail.item.wake.sessionId ? ' | session: ' + detail.item.wake.sessionId : '') }));
  if (detail.item.wake.workspacePath) {
    body.appendChild(el('p', { class: 'meta', text: 'workspace: ' + detail.item.wake.workspacePath }));
  }
  const lastRun = detail.runs.at(-1);
  if (lastRun && lastRun.sentinel === 'FAILED') {
    const retryBtn = el('button', { type: 'button', class: 'btn', text: 'Retry' });
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Queuing retry...';
      try {
        await postJson('/work-items/' + encodeURIComponent(detail.item.workItemKey) + '/retry');
        retryBtn.textContent = 'Retry queued';
      } catch (err) {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
        document.getElementById('status-summary').textContent = 'retry failed: ' + err.message;
      }
    });
    body.appendChild(retryBtn);
  }
  const resources = detail.item.correlatedResources || [];
  if (resources.length > 0) {
    body.appendChild(el('h3', { text: 'Resources' }));
    const resourceList = el('ul', { class: 'resource-list' });
    for (const res of resources) {
      const resUrl = resourceUriToUrl(res.resourceUri);
      const badge = el('span', { class: 'chip', text: res.role });
      const linkOrText = resUrl
        ? el('a', { href: resUrl, target: '_blank', rel: 'noopener noreferrer', text: res.resourceUri })
        : el('span', { class: 'meta', text: res.resourceUri });
      resourceList.appendChild(el('li', {}, [badge, linkOrText]));
    }
    body.appendChild(resourceList);
  }
  body.appendChild(el('h3', { text: 'Runs' }));
  body.appendChild(el('table', {}, [
    el('tr', {}, ['action', 'status', 'sentinel', 'started', 'runId'].map((h) => el('th', { text: h }))),
    ...detail.runs.map((r) => el('tr', {}, [
      el('td', { text: r.action }), el('td', { text: r.status }), el('td', { text: r.sentinel || '' }),
      el('td', { text: r.startedAt }), el('td', { text: r.runId }),
    ])),
  ]));
  body.appendChild(el('h3', { text: 'Context' }));
  body.appendChild(el('pre', { text: JSON.stringify(detail.item.context, null, 2) }));
  return body;
}

function renderTranscripts(transcripts) {
  if (!transcripts.enabled) {
    return el('p', { class: 'meta', text: 'Transcripts are not enabled \\u2014 set transcripts.enabled: true in config to turn them on.' });
  }
  if (!transcripts.sessions || transcripts.sessions.length === 0) {
    return el('p', { class: 'meta', text: 'No transcripts available for this item.' });
  }
  const root = el('div');
  for (const session of transcripts.sessions) {
    const firstStartedAt = session.entries[0] ? session.entries[0].startedAt : '';
    const sessionLabel = session.sessionId || session.sessionKey;
    root.appendChild(
      el('div', {
        class: 'transcript-session',
        text:
          '\\u2014 new session \\u00b7 ' +
          sessionLabel +
          ' \\u00b7 ' +
          firstStartedAt +
          ' \\u2014',
      }),
    );
    for (const entry of session.entries) {
      root.appendChild(el('article', { class: 'transcript-entry' }, [
        el('div', { class: 'transcript-head', text: entry.role + ' \\u00b7 ' + entry.action + ' \\u00b7 ' + entry.cli + ' \\u00b7 ' + entry.startedAt }),
        el('pre', { class: 'transcript-text', text: entry.text }),
      ]));
    }
  }
  return root;
}

async function renderActivity(context) {
  const events = await getJson('/events?limit=200', context.signal);
  if (!isActiveRequest(context.requestId)) return;
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

function fmtCost(usd) {
  if (usd === undefined || usd === null) return '';
  return '$' + Number(usd).toFixed(usd < 1 ? 4 : 2);
}

function fmtTokens(tokenUsage) {
  if (!tokenUsage) return '';
  const total =
    (tokenUsage.inputTokens || 0) + (tokenUsage.outputTokens || 0) +
    (tokenUsage.cacheCreationInputTokens || 0) + (tokenUsage.cacheReadInputTokens || 0);
  return total >= 1000 ? (total / 1000).toFixed(1) + 'k' : String(total);
}

function fmtNumber(value) {
  return Number(value || 0).toLocaleString();
}

function fmtDuration(ms) {
  return ms === undefined || ms === null ? '' : fmtMs(ms);
}

function metricBar(value, max) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return el('div', { class: 'metric-bar' }, [
    el('div', { class: 'metric-bar-fill', style: 'width:' + pct + '%' }),
  ]);
}

function stackedBar(segments) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return el('div', { class: 'stacked-bar' }, segments.filter((segment) => segment.value > 0).map((segment) =>
    el('div', {
      class: 'stacked-segment',
      title: segment.label + ': ' + fmtNumber(segment.value),
      style: 'width:' + ((segment.value / total) * 100).toFixed(2) + '%;background:' + segment.color,
    }),
  ));
}

function selectBox(value, options, onChange) {
  return el('select', { onchange: (event) => onChange(event.target.value) }, options.map((option) =>
    el('option', {
      value: option[0],
      text: option[1],
      ...(option[0] === value ? { selected: 'selected' } : {}),
    }),
  ));
}

function metricValueCell(value, max, format) {
  return el('td', {}, [
    el('div', { class: 'metric-table-value' }, [
      el('span', { text: format(value) }),
      metricBar(value, max),
    ]),
  ]);
}

function renderCountTable(rows, label) {
  if (rows.length === 0) return el('p', { class: 'meta', text: 'No data for this window.' });
  const max = Math.max(...rows.map((row) => row.count));
  return el('table', {}, [
    el('tr', {}, [el('th', { text: label }), el('th', { text: 'runs' })]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.key }),
      metricValueCell(row.count, max, fmtNumber),
    ])),
  ]);
}

function renderTokenTable(rows, label) {
  if (rows.length === 0) return el('p', { class: 'meta', text: 'No data for this window.' });
  const max = Math.max(...rows.map((row) => row.tokens));
  return el('table', {}, [
    el('tr', {}, [
      el('th', { text: label }),
      el('th', { text: 'tokens' }),
      el('th', { text: 'avg/run' }),
      el('th', { text: 'cost' }),
      el('th', { text: 'avg cost/run' }),
      el('th', { text: 'runs' }),
    ]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.key }),
      metricValueCell(row.tokens, max, fmtNumber),
      el('td', { text: fmtNumber(row.averageTokens || 0) }),
      el('td', { text: fmtCost(row.costUsd) }),
      el('td', { text: fmtCost(row.averageCostUsd) }),
      el('td', { text: fmtNumber(row.count || 0) }),
    ])),
  ]);
}

function renderDurationTable(rows, label) {
  if (rows.length === 0) return el('p', { class: 'meta', text: 'No data for this window.' });
  const max = Math.max(...rows.map((row) => row.totalMs || row.medianMs));
  return el('table', {}, [
    el('tr', {}, [
      el('th', { text: label }),
      el('th', { text: 'total' }),
      el('th', { text: 'median' }),
      el('th', { text: 'average' }),
      el('th', { text: 'runs' }),
    ]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.key || row.label }),
      metricValueCell(row.totalMs || 0, max, fmtDuration),
      el('td', { text: fmtDuration(row.medianMs) }),
      el('td', { text: fmtDuration(row.averageMs) }),
      el('td', { text: fmtNumber(row.count) }),
    ])),
  ]);
}

function renderRunsOverTime(rows) {
  return el('table', {}, [
    el('tr', {}, [el('th', { text: 'bucket' }), el('th', { text: 'runs' }), el('th', { text: 'status split' })]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.label }),
      el('td', { text: fmtNumber(row.total) }),
      el('td', {}, [stackedBar([
        { label: 'completed', value: row.completed, color: '#7fe3a3' },
        { label: 'blocked', value: row.blocked, color: '#ffcf7f' },
        { label: 'awaiting approval', value: row.awaitingApproval, color: '#7fb3ff' },
        { label: 'failed', value: row.failed, color: '#ff8f7f' },
        { label: 'other', value: row.other, color: '#9aa2ad' },
      ])]),
    ])),
  ]);
}

function renderRunsByStatusOverTime(rows) {
  return el('table', {}, [
    el('tr', {}, [
      el('th', { text: 'bucket' }),
      el('th', { text: 'completed' }),
      el('th', { text: 'blocked' }),
      el('th', { text: 'awaiting approval' }),
      el('th', { text: 'failed' }),
      el('th', { text: 'other' }),
      el('th', { text: 'total' }),
    ]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.label }),
      el('td', { text: fmtNumber(row.completed) }),
      el('td', { text: fmtNumber(row.blocked) }),
      el('td', { text: fmtNumber(row.awaitingApproval) }),
      el('td', { text: fmtNumber(row.failed) }),
      el('td', { text: fmtNumber(row.other) }),
      el('td', { text: fmtNumber(row.total) }),
    ])),
  ]);
}

function renderTokensOverTime(rows) {
  return el('table', {}, [
    el('tr', {}, [el('th', { text: 'bucket' }), el('th', { text: 'tokens' }), el('th', { text: 'token split' }), el('th', { text: 'cost' })]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.label }),
      el('td', { text: fmtNumber(row.tokens) }),
      el('td', {}, [stackedBar([
        { label: 'input', value: row.inputTokens, color: '#7fb3ff' },
        { label: 'output', value: row.outputTokens, color: '#7fe3a3' },
        { label: 'cache creation', value: row.cacheCreationInputTokens, color: '#c79bff' },
        { label: 'cache read', value: row.cacheReadInputTokens, color: '#ffcf7f' },
      ])]),
      el('td', { text: fmtCost(row.costUsd) }),
    ])),
  ]);
}

function renderWorkItemsOverTime(rows) {
  const max = Math.max(0, ...rows.map((row) => row.completed));
  return el('table', {}, [
    el('tr', {}, [el('th', { text: 'bucket' }), el('th', { text: 'completed' })]),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.label }),
      metricValueCell(row.completed, max, fmtNumber),
    ])),
  ]);
}

function renderWorkItemDurations(rows) {
  if (rows.length === 0) return el('p', { class: 'meta', text: 'No completed work items for this window.' });
  const max = Math.max(...rows.map((row) => row.durationMs));
  return el('table', {}, [
    el('tr', {}, ['work item', 'duration', 'completed'].map((h) => el('th', { text: h }))),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.repo + '#' + row.issueNumber }),
      metricValueCell(row.durationMs, max, fmtDuration),
      el('td', { text: row.completedAt }),
    ])),
  ]);
}

function renderWorkItemTotals(rows) {
  if (rows.length === 0) return el('p', { class: 'meta', text: 'No runs for this window.' });
  const maxTokens = Math.max(...rows.map((row) => row.totalTokens));
  return el('table', {}, [
    el('tr', {}, ['work item', 'runs', 'total tokens', 'total duration'].map((h) => el('th', { text: h }))),
    ...rows.map((row) => el('tr', {}, [
      el('td', { text: row.key }),
      el('td', { text: String(row.runCount) }),
      metricValueCell(row.totalTokens, maxTokens, fmtNumber),
      el('td', { text: fmtMs(row.totalDurationMs) }),
    ])),
  ]);
}

function renderMetricDetail(detail) {
  if (detail.kind === 'runs-over-time') return renderRunsOverTime(detail.rows);
  if (detail.kind === 'runs-by-status-over-time') return renderRunsByStatusOverTime(detail.rows);
  if (detail.kind === 'run-counts') return renderCountTable(detail.rows, detail.group);
  if (detail.kind === 'tokens-over-time') return renderTokensOverTime(detail.rows);
  if (detail.kind === 'token-counts') return renderTokenTable(detail.rows, detail.group);
  if (detail.kind === 'durations') return renderDurationTable(detail.rows, detail.group);
  if (detail.kind === 'duration-over-time') return renderDurationTable(detail.rows, 'bucket');
  if (detail.kind === 'work-items-over-time') return renderWorkItemsOverTime(detail.rows);
  if (detail.kind === 'work-item-durations') return renderWorkItemDurations(detail.rows);
  if (detail.kind === 'work-item-totals') return renderWorkItemTotals(detail.rows);
  return el('p', { class: 'meta', text: 'Unsupported metric.' });
}

async function renderAnalytics(context) {
  const metrics = await getJson('/metrics?window=' + encodeURIComponent(analyticsWindow) + '&metric=' + encodeURIComponent(analyticsMetric), context.signal);
  if (!isActiveRequest(context.requestId)) return;
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.appendChild(el('div', { class: 'toolbar' }, [
    el('label', {}, [
      document.createTextNode('Window'),
      selectBox(analyticsWindow, [['1d', '1d'], ['3d', '3d'], ['5d', '5d'], ['7d', '7d']], (value) => {
        analyticsWindow = value;
        switchView('analytics');
      }),
    ]),
    el('label', {}, [
      document.createTextNode('Metric'),
      selectBox(analyticsMetric, METRIC_OPTIONS, (value) => {
        analyticsMetric = value;
        switchView('analytics');
      }),
    ]),
  ]));
  main.appendChild(el('div', { class: 'tiles' }, [
    tile('Runs', fmtNumber(metrics.summary.totalRuns)),
    tile('Completed', fmtNumber(metrics.summary.completedRuns)),
    tile('Blocked/approval', fmtNumber(metrics.summary.blockedRuns + metrics.summary.awaitingApprovalRuns)),
    tile('Failed', fmtNumber(metrics.summary.failedRuns)),
    tile('Tokens', fmtNumber(metrics.summary.totalTokens)),
    tile('Cost', fmtCost(metrics.summary.totalCostUsd)),
    tile('Median run', fmtDuration(metrics.summary.medianRunDurationMs) || '—'),
    tile('Work done', fmtNumber(metrics.summary.completedWorkItems)),
    tile('Median e2e', fmtDuration(metrics.summary.medianWorkItemDurationMs) || '—'),
  ]));
  main.appendChild(renderMetricDetail(metrics.detail));
}

async function renderRuns(context) {
  const runs = await getJson('/runs', context.signal);
  if (!isActiveRequest(context.requestId)) return;
  const main = document.getElementById('main');
  main.innerHTML = '';
  const table = el('table', {}, [
    el('tr', {}, ['repo#issue', 'action', 'status', 'sentinel', 'runner', 'tokens', 'cost', 'started', 'finished'].map((h) => el('th', { text: h }))),
    ...runs.map((r) => el('tr', {}, [
      el('td', { text: r.repo + '#' + r.issueNumber }), el('td', { text: r.action }), el('td', { text: r.status }),
      el('td', { text: r.sentinel || '' }), el('td', { text: r.routing ? r.routing.runnerName : '' }),
      el('td', { text: fmtTokens(r.tokenUsage) }), el('td', { text: fmtCost(r.tokenUsage && r.tokenUsage.costUsd) }),
      el('td', { text: r.startedAt }), el('td', { text: r.finishedAt || '' }),
    ])),
  ]);
  main.appendChild(table);
}

async function renderConfig(context) {
  const data = await getJson('/config', context.signal);
  if (!isActiveRequest(context.requestId)) return;
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.appendChild(el('h3', { text: 'Routing table' }));
  main.appendChild(el('table', {}, [
    el('tr', {}, ['stage', 'action', 'tier', 'runner', 'model', 'fallback order'].map((h) => el('th', { text: h }))),
    ...data.routingTable.map((r) => el('tr', {}, [
      el('td', { text: r.stage }), el('td', { text: r.action || '' }), el('td', { text: r.tier || '' }),
      el('td', { text: r.runnerName || '' }), el('td', { text: r.model || '' }),
      el('td', {}, (r.candidates || []).map((c) => {
        if (!c.paused) return el('span', { class: 'chip', text: c.runnerName });
        const btn = el('button', { type: 'button', class: 'btn', text: 'Unpause', style: 'margin-top:0;font-size:0.7rem;padding:0.1rem 0.4rem;' });
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Unpausing…';
          try {
            await postJson('/runners/' + encodeURIComponent(c.runnerName) + '/unpause');
            switchView('config');
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Unpause';
            document.getElementById('status-summary').textContent = 'unpause failed: ' + err.message;
          }
        });
        return el('span', { style: 'display:inline-flex;align-items:center;gap:0.25rem;margin-right:0.25rem;' }, [
          el('span', { class: 'chip amber', text: c.runnerName + ' (paused)' }),
          btn,
        ]);
      })),
    ])),
  ]));
  main.appendChild(el('h3', { text: 'Effective config (redacted)' }));
  main.appendChild(el('pre', { text: JSON.stringify(data.config, null, 2) }));
}

async function renderHealth(context) {
  const health = await getJson('/health', context.signal);
  if (!isActiveRequest(context.requestId)) return;
  const main = document.getElementById('main');
  main.innerHTML = '';
  const runnerNames = Object.keys(health.pause.runnerHealth || {});
  main.appendChild(el('div', { class: 'tiles' }, [
    tile('Tick lock', health.lock.present ? (health.lock.stale ? 'stale' : 'held') : 'free'),
    tile('Paused', String(health.pause.paused)),
    tile('Runners paused now', String(runnerNames.filter((name) => {
      const until = health.pause.runnerHealth[name].pausedUntil;
      return until && Date.parse(until) > Date.now();
    }).length)),
    tile('Integrity issues', String(health.integrityIssues.length)),
  ]));
  main.appendChild(el('h3', { text: 'Runner health (quota fallback, #67)' }));
  if (runnerNames.length === 0) {
    main.appendChild(el('p', { class: 'meta', text: 'No quota failures recorded.' }));
  } else {
    main.appendChild(el('table', {}, [
      el('tr', {}, ['runner', 'status', 'paused until', 'failure count', 'last failure'].map((h) => el('th', { text: h }))),
      ...runnerNames.map((name) => {
        const entry = health.pause.runnerHealth[name];
        const paused = entry.pausedUntil && Date.parse(entry.pausedUntil) > Date.now();
        return el('tr', {}, [
          el('td', { text: name }),
          el('td', {}, [el('span', { class: 'chip' + (paused ? ' amber' : ' ok') , text: paused ? 'paused' : 'available' })]),
          el('td', { text: entry.pausedUntil || '' }),
          el('td', { text: String(entry.failureCount || 0) }),
          el('td', { text: entry.lastFailureAt || '' }),
        ]);
      }),
    ]));
  }
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

const renderers = { board: renderBoard, activity: renderActivity, runs: renderRuns, analytics: renderAnalytics, config: renderConfig, health: renderHealth };

function switchView(view, options) {
  if (activeViewRequest) activeViewRequest.controller.abort();
  const controller = new AbortController();
  const requestId = ++activeViewRequestId;
  activeViewRequest = { id: requestId, controller };
  currentView = view;
  for (const btn of document.querySelectorAll('nav button')) {
    btn.classList.toggle('active', btn.dataset.view === view);
  }
  const main = document.getElementById('main');
  if (!options || options.showLoading !== false) {
    main.replaceChildren(loadingNode(view));
  }
  renderers[view]({ signal: controller.signal, requestId }).catch((err) => {
    if (err.name === 'AbortError' || !isActiveRequest(requestId)) return;
    main.replaceChildren(el('p', { class: 'meta red', text: 'Failed to load ' + view + ': ' + err.message }));
  });
}

for (const btn of document.querySelectorAll('nav button')) {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
}
document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.remove('open');
});
document.getElementById('modal-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'modal-overlay') {
    event.currentTarget.classList.remove('open');
  }
});
document.getElementById('force-tick').addEventListener('click', forceTickNow);

renderStatusBar();
switchView('board');
setInterval(() => {
  renderStatusBar();
  switchView(currentView, { showLoading: false });
}, 7000);
</script>
</body>
</html>
`;
