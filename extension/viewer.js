import { getAll } from './db.js';

const H = 30;          // row height
const PAD = 8;         // lane gutter
const KIND = {
  nav:      { label: 'same tab', color: 'var(--k-nav)', cls: '' },
  opened:   { label: 'opened',   color: 'var(--k-opened)', cls: '' },
  context:  { label: 'context',  color: 'var(--k-context)', cls: 'dash', dash: '4 3' },
  restored: { label: 'restored', color: 'var(--k-restored)', cls: 'dot', dash: '1.5 3' },
};
const RANK = { nav: 0, opened: 1, restored: 2, context: 3 };
const RANGES = { all: 0, '1h': 36e5, '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
const REASON = { 'new-tab': 'new tab', seed: 'already open', startup: 'startup', restored: 'restored', untracked: 'untracked', opened: 'opened', context: 'context', nav: 'navigated' };

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const hostOf = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.host : `${x.protocol}//${x.host}`; } catch { return ''; } };
const favicon = u => `/_favicon/?pageUrl=${encodeURIComponent(u || 'about:blank')}&size=16`;
const pad2 = n => String(n).padStart(2, '0');
const dt = t => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const shortTime = t => {
  const d = new Date(t), now = new Date();
  const hms = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hms : `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()} ${hms.slice(0, 5)}`;
};
const dur = ms => {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad2(Math.floor(s / 60) % 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
};
const tag = kind => kind ? `<span class="tag"><i class="${KIND[kind]?.cls ?? ''}" style="color:${KIND[kind]?.color ?? 'var(--ink-3)'}"></i>${esc(KIND[kind]?.label ?? kind)}</span>` : '';

// ---------- ui state ----------
const DEFAULTS = { view: 'graph', unit: 'visits', q: '', kinds: { nav: true, opened: true, context: true, restored: true }, range: 'all', status: 'all', win: 'all', sort: { key: 'n', dir: -1 }, colq: {} };
const stored = () => { try { return JSON.parse(localStorage.getItem('ui') || '{}'); } catch { return {}; } };
const ui = { ...DEFAULTS, ...stored(), sel: null, lineage: false, limit: 300 };
const params = new URLSearchParams(location.search);
for (const k of ['view', 'unit', 'win', 'range', 'status', 'q']) if (params.has(k)) ui[k] = params.get(k);
if (params.get('theme')) document.documentElement.dataset.theme = params.get('theme');
function save() {
  const { view, unit, kinds, range, status, win, sort, colq } = ui;
  try { localStorage.setItem('ui', JSON.stringify({ view, unit, kinds, range, status, win, sort, colq })); } catch {}
}

// ---------- data ----------
let raw = { visits: [], edges: [], cur: {}, liveTabs: new Map() };
let model = { list: [], byId: new Map(), parents: new Map(), children: new Map(), visitsOf: new Map() };
let lastChange = 0;

async function load() {
  const [visits, edges, st, tabs] = await Promise.all([getAll('visits'), getAll('edges'), chrome.storage.local.get('state'), chrome.tabs.query({})]);
  raw = { visits, edges, cur: st.state?.cur ?? {}, liveTabs: new Map(tabs.map(t => [t.id, t])) };
  lastChange = Math.max(0, ...visits.map(v => v.seen > v.t ? v.seen : v.t), ...edges.map(e => e.t));
  build();
  render();
}

function build() {
  const curOf = new Map();
  for (const [tab, id] of Object.entries(raw.cur)) if (raw.liveTabs.has(+tab)) curOf.set(id, raw.liveTabs.get(+tab));
  const visitNode = v => {
    const tab = curOf.get(v.id);
    return {
      id: v.id, n: v.n, t: v.t, end: tab ? null : (v.closed ?? v.ended ?? null), title: v.title, url: v.url, host: hostOf(v.url),
      tabId: v.tabId, windowId: v.windowId, live: !!tab, active: !!tab?.active, closed: !!v.closed && !tab, reason: v.reason,
      transition: v.transition, qualifiers: v.qualifiers, redirects: v.redirects, reloads: v.reloads, views: v.views ?? 0,
      seen: v.seen, session: v.session, tabKey: v.tabKey, pages: 1, visitIds: [v.id],
    };
  };
  const list = [], parents = new Map(), children = new Map();
  const link = (from, to, kind, label) => {
    const p = parents.get(to) ?? [];
    if (p.some(x => x.id === from && x.kind === kind)) return;
    p.push({ id: from, kind, label });
    parents.set(to, p);
    const c = children.get(from) ?? [];
    c.push({ id: to, kind, label });
    children.set(from, c);
  };

  const visits = [...raw.visits].sort((a, b) => a.n - b.n);
  if (ui.unit === 'tabs') {
    const groups = new Map(), groupOf = new Map();
    for (const v of visits) {
      const key = v.tabKey ?? `${v.session}:${v.tabId}`;
      groupOf.set(v.id, key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    for (const [key, vs] of groups) {
      const first = visitNode(vs[0]), last = visitNode(vs.at(-1));
      list.push({ ...last, id: key, n: first.n, t: first.t, reason: first.reason, transition: first.transition, qualifiers: first.qualifiers,
        pages: vs.length, visitIds: vs.map(v => v.id), views: vs.reduce((s, v) => s + (v.views ?? 0), 0), title: last.title || first.title });
    }
    for (const e of raw.edges) {
      if (e.kind === 'nav') continue;
      const a = groupOf.get(e.from), b = groupOf.get(e.to);
      if (a && b && a !== b) link(a, b, e.kind, e.label);
    }
  } else {
    for (const v of visits) list.push(visitNode(v));
    for (const e of raw.edges) link(e.from, e.to, e.kind, e.label);
  }
  for (const n of list) {
    const ps = (parents.get(n.id) ?? []).sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    n.via = ps[0]?.kind ?? null;
    n.viaText = ps[0] ? (ps[0].kind === 'nav' ? ps[0].label || 'link' : KIND[ps[0].kind].label) : REASON[n.reason] ?? n.reason ?? '';
    n.status = n.active ? 'active' : n.live ? 'open' : n.closed ? 'closed' : 'left';
  }
  model = { list, byId: new Map(list.map(n => [n.id, n])), parents, children };
  for (const n of list) {
    const p = parents.get(n.id)?.[0];
    n.from = p ? model.byId.get(p.id)?.title || model.byId.get(p.id)?.url || '' : '';
    n.kids = children.get(n.id)?.length ?? 0;
  }
}

const enabled = rel => (rel ?? []).filter(r => ui.kinds[r.kind]);

function lineageOf(id) {
  const out = new Set([id]);
  for (const dir of [model.parents, model.children]) {
    const stack = [id];
    while (stack.length) for (const r of enabled(dir.get(stack.pop()))) if (!out.has(r.id)) { out.add(r.id); stack.push(r.id); }
  }
  return out;
}

// ---------- filtering ----------
let rows = [], vparents = new Map(), highlight = null, shownCount = 0;

function derive() {
  const now = Date.now(), since = RANGES[ui.range] ? now - RANGES[ui.range] : 0;
  const terms = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
  const lineage = ui.sel && model.byId.has(ui.sel) ? lineageOf(ui.sel) : null;
  highlight = lineage;
  const ok = n => (!since || n.live || (n.end ?? now) >= since)
    && (ui.status === 'all' || (ui.status === 'open') === n.live)
    && (ui.win === 'all' || String(n.windowId) === ui.win)
    && (!terms.length || terms.every(t => `${n.title} ${n.url}`.toLowerCase().includes(t)))
    && (!ui.lineage || !lineage || lineage.has(n.id));
  const visible = new Set();
  for (const n of model.list) if (ok(n)) visible.add(n.id);

  // Hidden parents are bridged to their nearest visible ancestors ("indirect" edges).
  // model.list is in ascending n, i.e. topological order, so ancestors are resolved first.
  const up = new Map();
  vparents = new Map();
  for (const n of model.list) {
    const direct = [], via = new Map();
    for (const p of enabled(model.parents.get(n.id))) {
      if (visible.has(p.id)) direct.push(p);
      else for (const a of up.get(p.id) ?? []) if (!via.has(a)) via.set(a, p.kind);
    }
    if (visible.has(n.id)) {
      const ids = new Set(direct.map(p => p.id));
      vparents.set(n.id, [...direct, ...[...via].filter(([a]) => !ids.has(a)).map(([id, kind]) => ({ id, kind, indirect: true }))]);
    } else {
      up.set(n.id, [...new Set([...direct.map(p => p.id), ...via.keys()])]);
    }
  }
  rows = model.list.filter(n => visible.has(n.id)).sort((a, b) => b.n - a.n);
}

// ---------- git-log style lane layout ----------
// Rows are newest first; every edge runs downward from a child row to its parent row.
// Each pending edge occupies a lane until its parent row; edges to the same parent with the
// same kind share a lane, as in `git log --graph`.
function layout(rows) {
  const rowOf = new Map(rows.map((r, i) => [r.id, i]));
  const lanes = [], col = [], width = [], edges = [];
  const free = () => { let i = lanes.indexOf(null); if (i < 0) { i = lanes.length; lanes.push(null); } return i; };
  rows.forEach((r, i) => {
    let c = -1;
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k]?.target !== r.id) continue;
      if (c < 0) c = k;
      for (const e of lanes[k].edges) e.end = i;
      lanes[k] = null;
    }
    if (c < 0) c = free();
    col[i] = c;
    const ps = (vparents.get(r.id) ?? []).filter(p => rowOf.has(p.id))
      .sort((a, b) => (a.indirect ?? 0) - (b.indirect ?? 0) || RANK[a.kind] - RANK[b.kind]);
    ps.forEach((p, j) => {
      const e = { from: i, end: null, kind: p.kind, indirect: !!p.indirect, source: r.id, target: p.id };
      let k = lanes.findIndex(l => l && l.target === p.id && l.kind === p.kind && l.indirect === e.indirect);
      if (k < 0) {
        k = j === 0 && lanes[c] == null ? c : free();
        lanes[k] = { target: p.id, kind: p.kind, indirect: e.indirect, edges: [] };
      }
      lanes[k].edges.push(e);
      e.lane = k;
      edges.push(e);
    });
    width[i] = Math.max(lanes.length, c + 1);
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
  });
  return { col, width, edges };
}

function edgePath(e, col, X, Y, bottom) {
  const x0 = X(col[e.from]), y0 = Y(e.from), xl = X(e.lane);
  if (e.end != null && e.end - e.from === 1) {
    const x1 = X(col[e.end]), y1 = Y(e.end);
    return `M${x0},${y0} C${x0},${y0 + H / 2} ${x1},${y1 - H / 2} ${x1},${y1}`;
  }
  let d = `M${x0},${y0}`;
  if (xl !== x0) d += ` C${x0},${y0 + H * 0.5} ${xl},${y0 + H * 0.3} ${xl},${y0 + H * 0.8}`;
  if (e.end == null) return `${d} L${xl},${bottom}`;
  const x1 = X(col[e.end]), y1 = Y(e.end);
  if (xl === x1) return `${d} L${x1},${y1}`;
  return `${d} L${xl},${y1 - H * 0.8} C${xl},${y1 - H * 0.3} ${x1},${y1 - H * 0.5} ${x1},${y1}`;
}

// ---------- rendering ----------
function render() {
  derive();
  for (const id of ['view', 'unit']) for (const b of $(`#${id}`).children) b.classList.toggle('on', b.dataset.v === ui[id]);
  for (const b of $('#kinds').children) b.classList.toggle('on', !!ui.kinds[b.dataset.k]);
  $('#q').value !== ui.q && ($('#q').value = ui.q);
  $('#range').value = ui.range;
  $('#status').value = ui.status;
  renderWindows();
  renderStats();
  const focus = document.activeElement?.dataset?.col, caret = document.activeElement?.selectionStart;
  ui.view === 'grid' ? renderGrid() : renderGraph();
  if (focus) { const el = $(`input[data-col="${focus}"]`); el?.focus(); el?.setSelectionRange(caret, caret); }
  renderDetail();
  renderFoot();
}

function renderStats() {
  const tabs = new Set(raw.visits.map(v => v.tabKey));
  const open = Object.keys(raw.cur).filter(t => raw.liveTabs.has(+t)).length;
  const s = [['visits', raw.visits.length], ['tabs', tabs.size], ['open now', open], ['edges', raw.edges.length]];
  $('#stats').innerHTML = s.map(([k, v]) => `<div><dt>${k}</dt><dd>${v.toLocaleString('en')}</dd></div>`).join('');
}

function renderWindows() {
  const counts = new Map();
  for (const v of raw.visits) counts.set(v.windowId, (counts.get(v.windowId) ?? 0) + 1);
  const live = new Set([...raw.liveTabs.values()].map(t => t.windowId));
  const ids = [...counts.keys()].sort((a, b) => (live.has(b) - live.has(a)) || b - a);
  if (ui.win !== 'all' && !counts.has(+ui.win)) ids.unshift(+ui.win);
  $('#win').innerHTML = `<option value="all">All windows</option>` +
    ids.map(id => `<option value="${id}">Window ${id}${live.has(id) ? '' : ' · closed'} (${counts.get(id) ?? 0})</option>`).join('');
  $('#win').value = ui.win;
}

function emptyState() {
  return raw.visits.length
    ? `<div class="empty"><b>Nothing matches.</b>Loosen the filter, time range or window.</div>`
    : `<div class="empty"><b>Nothing recorded yet.</b>Open a link in a new tab and it appears here.</div>`;
}

function renderGraph() {
  const pane = $('#pane');
  shownCount = 0;
  if (!rows.length) return void (pane.innerHTML = emptyState());
  shownCount = rows.length;
  const shown = rows.slice(0, ui.limit);
  const L = layout(rows);
  const lanes = Math.max(1, ...L.width.slice(0, shown.length));
  const lw = lanes <= 16 ? 14 : Math.max(5, 224 / lanes);
  const gw = PAD * 2 + (lanes - 1) * lw;
  const X = c => PAD + c * lw, Y = i => i * H + H / 2, bottom = shown.length * H;
  const dim = id => highlight && !highlight.has(id);

  const paths = L.edges.filter(e => e.from < shown.length).map(e => {
    const k = KIND[e.kind];
    const dash = e.indirect ? '1 4' : k.dash;
    const faded = dim(e.source) || dim(e.target) ? ' class="dim"' : '';
    return `<path${faded} d="${edgePath(e, L.col, X, Y, bottom)}" stroke="${k.color}"${dash ? ` stroke-dasharray="${dash}"` : ''}${e.indirect ? ' opacity=".7"' : ''}/>`;
  }).join('');
  const nodes = shown.map((n, i) => {
    const r = n.reason === 'nav' ? 3.2 : 4.4, x = X(L.col[i]), y = Y(i);
    return `<g${dim(n.id) ? ' class="dim"' : ''}>${n.id === ui.sel ? `<circle class="halo" cx="${x}" cy="${y}" r="${r + 4}"/>` : ''}<circle class="node${n.live ? ' live' : ''}${n.active ? ' active' : ''}" cx="${x}" cy="${y}" r="${r}"/></g>`;
  }).join('');

  pane.innerHTML = `<div class="graph">
    <svg class="lanes" width="${gw}" height="${bottom}">${paths}${nodes}</svg>
    ${shown.map(n => `<div class="row${n.id === ui.sel ? ' sel' : ''}${dim(n.id) ? ' dim' : ''}${n.live ? '' : ' closed'}" data-id="${esc(n.id)}" style="padding-left:${gw + 32}px" title="${esc(n.url)}">
      <img src="${favicon(n.url)}" alt="">
      <span class="t"><span class="title">${esc(n.title || n.url || '(untitled)')}</span><span class="host">${esc(n.host)}${n.pages > 1 ? ` · ${n.pages} pages` : ''}</span></span>
      <span>${n.via ? tag(n.via) : `<span class="tag">${esc(n.viaText)}</span>`}</span>
      <span class="num">${n.tabId != null ? `tab ${n.tabId}` : ''}</span>
      <span class="num">${shortTime(n.t)}</span>
    </div>`).join('')}
  </div>${rows.length > shown.length ? `<button class="link more" id="more">Show ${Math.min(300, rows.length - shown.length)} more of ${rows.length - shown.length}</button>` : ''}`;
}

const COLS = [
  { k: 'n', h: '#', v: n => n.n, num: true, w: 64 },
  { k: 'title', h: 'Title', v: n => n.title || n.url, filter: true, w: 320 },
  { k: 'host', h: 'Host', v: n => n.host, filter: true, w: 150 },
  { k: 'via', h: 'Via', v: n => n.viaText, filter: true, w: 110 },
  { k: 'from', h: 'From', v: n => n.from, filter: true, w: 200 },
  { k: 'pages', h: 'Pages', v: n => n.pages, num: true, w: 70, unit: 'tabs' },
  { k: 'kids', h: 'Children', v: n => n.kids, num: true, w: 84 },
  { k: 'tab', h: 'Tab', v: n => n.tabId, num: true, w: 104 },
  { k: 'win', h: 'Window', v: n => n.windowId, num: true, w: 112 },
  { k: 't', h: 'Opened', v: n => n.t, fmt: dt, w: 160 },
  { k: 'dur', h: 'Duration', v: n => (n.end ?? Date.now()) - n.t, fmt: dur, num: true, w: 96 },
  { k: 'status', h: 'Status', v: n => n.status, filter: true, w: 90 },
];

function renderGrid() {
  const pane = $('#pane');
  const cols = COLS.filter(c => !c.unit || c.unit === ui.unit);
  const col = cols.find(c => c.k === ui.sort.key) ?? cols[0];
  const colq = Object.entries(ui.colq).filter(([k, q]) => q && cols.some(c => c.k === k && c.filter));
  let list = rows.filter(n => colq.every(([k, q]) => String(cols.find(c => c.k === k).v(n) ?? '').toLowerCase().includes(q.toLowerCase())));
  const dir = ui.sort.dir;
  list = list.sort((a, b) => {
    const x = col.v(a), y = col.v(b);
    return (x == null) - (y == null) || (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  shownCount = list.length;
  const shown = list.slice(0, ui.limit);
  pane.innerHTML = `<table>
    <colgroup>${cols.map(c => `<col style="width:${c.w}px">`).join('')}</colgroup>
    <thead><tr>${cols.map(c => `<th data-sort="${c.k}" class="${c.num ? 'n' : ''}${c.k === col.k ? ' on' : ''}">${c.h}${c.k === col.k ? `<span class="dir">${dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>
    <tr class="filters">${cols.map(c => `<th>${c.filter ? `<input data-col="${c.k}" placeholder="filter" value="${esc(ui.colq[c.k] ?? '')}" spellcheck="false">` : ''}</th>`).join('')}</tr></thead>
    <tbody>${shown.map(n => `<tr data-id="${esc(n.id)}" class="${n.id === ui.sel ? 'sel' : ''}" title="${esc(n.url)}">${cols.map(c => {
      const v = c.v(n);
      if (c.k === 'title') return `<td><span class="cell-title"><img src="${favicon(n.url)}" alt=""><span>${esc(v || '(untitled)')}</span></span></td>`;
      if (c.k === 'via') return `<td>${n.via ? tag(n.via) + (n.via === 'nav' ? ` <span class="num">${esc(n.viaText)}</span>` : '') : `<span class="tag">${esc(v)}</span>`}</td>`;
      if (c.k === 'status') return `<td><span class="status ${v}">${v}</span></td>`;
      return `<td class="${c.num ? 'n' : ''}${c.k === 'from' || c.k === 'host' ? ' dim' : ''}">${esc(c.fmt ? c.fmt(v) : v)}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table>${list.length ? '' : emptyState()}${list.length > shown.length ? `<button class="link more" id="more">Show ${Math.min(300, list.length - shown.length)} more of ${list.length - shown.length}</button>` : ''}`;
}

function renderDetail() {
  const el = $('#detail');
  const n = model.byId.get(ui.sel);
  el.hidden = !n;
  if (!n) return;
  const rel = list => list?.length
    ? list.map(r => { const m = model.byId.get(r.id); return `<div class="rel" data-id="${esc(r.id)}">${tag(r.kind)}<span class="rt" title="${esc(m?.url)}">${esc(m?.title || m?.url || r.id)}${r.kind === 'nav' && r.label ? ` <span class="num">· ${esc(r.label)}</span>` : ''}</span></div>`; }).join('')
    : '<p class="none">None</p>';
  const meta = [
    ['Status', `<span class="status ${n.status}">${n.status}</span>`],
    ['Tab · window', `${n.tabId ?? '–'} · ${n.windowId ?? '–'}`],
    ['Opened', dt(n.t)],
    [n.closed ? 'Closed' : 'Left', n.end ? dt(n.end) : '–'],
    ['Duration', dur((n.end ?? Date.now()) - n.t)],
    ['Via', esc(n.viaText)],
    ['Origin', esc(REASON[n.reason] ?? n.reason ?? '')],
    ['Transition', esc([n.transition, ...(n.qualifiers ?? [])].filter(Boolean).join(' · ') || '–')],
    ...(ui.unit === 'tabs' ? [['Pages', n.pages]] : []),
    ...(n.redirects?.length ? [['Redirected from', n.redirects.map(esc).join('<br>')]] : []),
    ...(n.reloads ? [['Reloads', n.reloads]] : []),
    ['Views', n.views],
    ['Last viewed', n.seen ? dt(n.seen) : '–'],
  ];
  el.innerHTML = `<button class="close" id="close" title="Close (Esc)">×</button>
    <span class="label">${ui.unit === 'tabs' ? 'Tab' : `Visit · #${n.n}`}</span>
    <h2>${esc(n.title || '(untitled)')}</h2>
    <a class="url" href="${esc(n.url)}" target="_blank" rel="noreferrer">${esc(n.url)}</a>
    <div class="btns">
      ${n.live ? '<button class="link" id="goto">Go to tab</button>' : ''}
      <button class="link${ui.lineage ? ' on' : ''}" id="lineage">Lineage only</button>
      <button class="link" id="copy">Copy URL</button>
      <button class="link danger" id="forget">Forget</button>
    </div>
    <dl>${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <h3>From</h3>${rel(model.parents.get(n.id))}
    <h3>Opened / led to</h3>${rel(model.children.get(n.id))}`;
}

function renderFoot() {
  $('#foot').innerHTML = `<span class="live-dot"></span>Recording · ${shownCount.toLocaleString('en')} shown${lastChange ? ` · last change ${shortTime(lastChange)}` : ''}`;
  $('#legend').innerHTML = Object.keys(KIND).map(tag).join('') + `<span class="tag"><i class="dot" style="color:var(--ink-3)"></i>indirect</span>`;
}

// ---------- interaction ----------
let reload;
const schedule = () => { clearTimeout(reload); reload = setTimeout(load, 200); };
new BroadcastChannel('provenance').onmessage = schedule;
chrome.tabs.onActivated.addListener(schedule);
chrome.tabs.onRemoved.addListener(schedule);
setInterval(() => document.visibilityState === 'visible' && renderFoot(), 30000);

const set = (patch, rebuild = false) => { Object.assign(ui, patch); save(); if (rebuild) build(); render(); };

$('#kinds').innerHTML = Object.entries(KIND).map(([k, d]) =>
  `<button data-k="${k}" title="Show ${d.label} edges"><svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="${d.color}" stroke-width="1.6"${d.dash ? ` stroke-dasharray="${d.dash}"` : ''}/></svg>${d.label}</button>`).join('');

$('#view').onclick = e => e.target.dataset.v && set({ view: e.target.dataset.v, limit: 300 });
$('#unit').onclick = e => e.target.dataset.v && e.target.dataset.v !== ui.unit && set({ unit: e.target.dataset.v, sel: null, lineage: false, limit: 300 }, true);
$('#kinds').onclick = e => { const b = e.target.closest('button'); if (b) set({ kinds: { ...ui.kinds, [b.dataset.k]: !ui.kinds[b.dataset.k] } }); };
let typing;
$('#q').oninput = e => { clearTimeout(typing); typing = setTimeout(() => set({ q: e.target.value, limit: 300 }), 120); };
$('#range').onchange = e => set({ range: e.target.value });
$('#status').onchange = e => set({ status: e.target.value });
$('#win').onchange = e => set({ win: e.target.value });

$('#pane').addEventListener('click', e => {
  if (e.target.id === 'more') return set({ limit: ui.limit + 300 });
  const th = e.target.closest('th[data-sort]');
  if (th) { const k = th.dataset.sort; return set({ sort: { key: k, dir: ui.sort.key === k ? -ui.sort.dir : (k === 'title' || k === 'host' || k === 'via' || k === 'from' || k === 'status' ? 1 : -1) } }); }
  const row = e.target.closest('[data-id]');
  if (row) set({ sel: row.dataset.id === ui.sel ? null : row.dataset.id, lineage: row.dataset.id === ui.sel ? false : ui.lineage });
});
$('#pane').addEventListener('dblclick', e => { const row = e.target.closest('[data-id]'); if (row) goto(model.byId.get(row.dataset.id)); });
$('#pane').addEventListener('input', e => {
  if (!e.target.dataset.col) return;
  clearTimeout(typing);
  typing = setTimeout(() => set({ colq: { ...ui.colq, [e.target.dataset.col]: e.target.value } }), 120);
});

$('#detail').addEventListener('click', async e => {
  const n = model.byId.get(ui.sel);
  const rel = e.target.closest('.rel');
  if (rel) return set({ sel: rel.dataset.id });
  switch (e.target.id) {
    case 'close': return set({ sel: null, lineage: false });
    case 'goto': return goto(n);
    case 'lineage': return set({ lineage: !ui.lineage });
    case 'copy': await navigator.clipboard.writeText(n.url).catch(() => {}); e.target.textContent = 'Copied'; return;
    case 'forget':
      if (!e.target.classList.contains('armed')) { e.target.classList.add('armed'); e.target.textContent = 'Confirm forget'; return; }
      await chrome.runtime.sendMessage({ type: 'forget', ids: n.visitIds });
      return set({ sel: null, lineage: false });
  }
});

async function goto(n) {
  if (!n?.live) return;
  await chrome.tabs.update(n.tabId, { active: true });
  await chrome.windows.update(n.windowId, { focused: true });
}

$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, visits: raw.visits, edges: raw.edges }, null, 1)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `tab-dag-${dt(Date.now()).replace(/[: ]/g, '-')}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

let disarm;
$('#clear').onclick = async e => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed'); b.textContent = 'Confirm clear';
    disarm = setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Clear'; }, 4000);
    return;
  }
  clearTimeout(disarm);
  b.classList.remove('armed'); b.textContent = 'Clear';
  await chrome.runtime.sendMessage({ type: 'clear' });
  set({ sel: null, lineage: false });
};

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'Escape') set({ sel: null, lineage: false });
  else if (e.key === 'g') set({ view: 'graph' });
  else if (e.key === 'd') set({ view: 'grid' });
  else if (e.key === 'j' || e.key === 'k') {
    const ids = [...document.querySelectorAll('#pane [data-id]')].map(r => r.dataset.id);
    const i = ids.indexOf(ui.sel), next = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'j' ? 1 : -1)))];
    if (next) { set({ sel: next }); document.querySelector(`#pane [data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }
});

load();
