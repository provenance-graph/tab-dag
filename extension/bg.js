// Tab Dag — service worker.
// Nodes are visits (one page view in one tab); edges point from an older visit to a newer one:
//   opened   — the new tab's opener tab was showing this visit (tabs.openerTabId / onCreatedNavigationTarget)
//   context  — no opener, or a different one: the tab that was active in the same window just before
//   nav      — same-tab navigation (label = transition type)
//   restored — a tab restored after a browser restart, matched by URL to a visit open in the previous session
// Every edge satisfies from.n < to.n, so the graph is a DAG by construction.
import { get, byIndex, write, clear } from './db.js';

const OWN = chrome.runtime.getURL('');
const VIEWER = chrome.runtime.getURL('viewer.html');
const PLACEHOLDER = /^(chrome:\/\/(newtab|new-tab-page)\/?|chrome-search:\/\/local-ntp|about:blank)/;
const STARTUP_WINDOW = 8000;
const swStart = Date.now();
const bc = new BroadcastChannel('provenance');

const isOwn = u => !!u && u.startsWith(OWN);
const strip = u => (u || '').split('#')[0];

// Tab ids -> visits and other bookkeeping live in storage.local so they survive worker shutdown
// and extension reloads; onStartup discards them because tab ids do not survive a browser restart.
let state;
const fresh = () => ({ session: crypto.randomUUID(), seq: 0, cur: {}, active: {}, pendingSource: {}, prerender: {}, ignore: {}, startupAt: 0 });
const ready = chrome.storage.local.get('state').then(r => { state = { ...fresh(), ...r.state }; });

class Batch {
  v = new Map();
  dirty = new Set();
  edges = new Map();
  dropV = new Set();
  dropE = new Set();

  async visit(id) {
    if (!id) return null;
    if (!this.v.has(id)) this.v.set(id, (await get('visits', id)) ?? null);
    return this.v.get(id);
  }
  put(v) { this.v.set(v.id, v); this.dirty.add(v.id); return v; }
  edge(from, to, kind, label) {
    if (!from || !to || from.n >= to.n) return;
    const id = `${from.id}>${to.id}>${kind}`;
    this.edges.set(id, { id, from: from.id, to: to.id, kind, label, t: Date.now() });
  }
  async drop(v) {
    this.dropV.add(v.id);
    for (const e of [...await byIndex('edges', 'from', v.id), ...await byIndex('edges', 'to', v.id)]) this.dropE.add(e.id);
    for (const [id, e] of this.edges) if (e.from === v.id || e.to === v.id) this.edges.delete(id);
  }
  get empty() { return !this.dirty.size && !this.edges.size && !this.dropV.size && !this.dropE.size; }
  commit() {
    if (this.empty) return;
    return write(s => {
      for (const id of this.dirty) if (!this.dropV.has(id)) s.visits.put(this.v.get(id));
      for (const e of this.edges.values()) s.edges.put(e);
      for (const id of this.dropV) s.visits.delete(id);
      for (const id of this.dropE) s.edges.delete(id);
    });
  }
}

// All handlers run one at a time so read-modify-write on state and the db never interleaves.
let queue = Promise.resolve();
function op(name, fn) {
  queue = queue.then(async () => {
    await ready;
    const c = new Batch();
    await fn(c);
    await c.commit();
    await chrome.storage.local.set({ state });
    if (!c.empty || name !== 'activated') bc.postMessage({ op: name, t: Date.now() });
  }).catch(e => console.error(`[provenance] ${name}`, e));
  return queue;
}

function newVisit(c, f) {
  return c.put({ id: crypto.randomUUID(), n: ++state.seq, t: Date.now(), session: state.session, title: '', ...f });
}

async function linkRestored(c, v) {
  if (!v.url || PLACEHOLDER.test(v.url)) return;
  v.restoreChecked = true;
  const candidates = (await byIndex('visits', 'url', v.url))
    .filter(p => p.session !== state.session && !p.closed && p.id !== v.id)
    .sort((a, b) => b.n - a.n);
  for (const p of candidates) {
    const prior = await c.visit(p.id);
    if (prior.successor) continue;
    prior.successor = v.id;
    prior.ended ??= Date.now();
    c.put(prior);
    c.edge(prior, v, 'restored');
    v.reason = 'restored';
    return;
  }
}

async function seed(c, reason) {
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  // openers first, so opener visits get the smaller sequence number
  const order = [], seen = new Set();
  const visitTab = t => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    if (byId.has(t.openerTabId)) visitTab(byId.get(t.openerTabId));
    order.push(t);
  };
  tabs.forEach(visitTab);

  for (const t of order) {
    const url = t.url || t.pendingUrl || '';
    if (t.active) state.active[t.windowId] = [t.id, ...(state.active[t.windowId] ?? []).filter(x => x !== t.id)];
    if (isOwn(url)) { state.ignore[t.id] = true; continue; }
    const known = await c.visit(state.cur[t.id]);
    if (known && strip(known.url) === strip(url)) continue;
    const v = newVisit(c, { tabId: t.id, windowId: t.windowId, tabKey: crypto.randomUUID(), url, title: t.title || '', favIconUrl: t.favIconUrl, reason });
    state.cur[t.id] = v.id;
    const opener = await c.visit(state.cur[t.openerTabId]);
    if (opener) c.edge(opener, v, 'opened');
    if (reason === 'restored') await linkRestored(c, v);
  }
}

async function navigate(c, tabId, url, transition, qualifiers = []) {
  const prev = await c.visit(state.cur[tabId]);
  if (isOwn(url)) {
    if (prev && (prev.pending || PLACEHOLDER.test(prev.url))) await c.drop(prev);
    else if (prev) c.put(Object.assign(prev, { ended: Date.now() }));
    delete state.cur[tabId];
    state.ignore[tabId] = true;
    return;
  }
  delete state.ignore[tabId];
  if (!prev) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    state.cur[tabId] = newVisit(c, { tabId, windowId: tab?.windowId, tabKey: crypto.randomUUID(), url, title: tab?.title ?? '', reason: 'untracked', transition, qualifiers }).id;
    return;
  }
  // Fold into the current visit: the tab's first commit, a new-tab page being replaced,
  // a script/meta redirect, a reload, or the same URL again.
  const placeholder = PLACEHOLDER.test(prev.url) && !(await byIndex('edges', 'from', prev.id)).length;
  const first = prev.pending || placeholder;
  if (first || qualifiers.includes('client_redirect') || transition === 'reload' || prev.url === url) {
    if (!first && prev.url !== url) (prev.redirects ??= []).push(prev.url);
    if (transition === 'reload') prev.reloads = (prev.reloads ?? 0) + 1;
    if (first || !prev.transition) Object.assign(prev, { transition, qualifiers });
    Object.assign(prev, { url, pending: false });
    delete prev.ended;
    if (!prev.restoreChecked && (prev.reason === 'startup' || prev.reason === 'restored')) await linkRestored(c, prev);
    c.put(prev);
    return;
  }
  c.put(Object.assign(prev, { ended: Date.now() }));
  const v = newVisit(c, { tabId, windowId: prev.windowId, tabKey: prev.tabKey, url, transition, qualifiers, reason: 'nav' });
  state.cur[tabId] = v.id;
  c.edge(prev, v, 'nav', qualifiers.includes('forward_back') ? 'back/forward' : transition);
}

chrome.tabs.onCreated.addListener(t => op('created', async c => {
  const url = t.pendingUrl || t.url || '';
  if (isOwn(url)) { state.ignore[t.id] = true; return; }
  if (state.cur[t.id]) return;
  const startup = Date.now() - state.startupAt < STARTUP_WINDOW;
  const v = newVisit(c, { tabId: t.id, windowId: t.windowId, tabKey: crypto.randomUUID(), url, title: t.title || '', pending: true, reason: startup ? 'startup' : 'new-tab' });
  state.cur[t.id] = v.id;
  const openerTab = t.openerTabId ?? state.pendingSource[t.id];
  delete state.pendingSource[t.id];
  const opener = await c.visit(state.cur[openerTab]);
  if (opener) { c.edge(opener, v, 'opened'); v.reason = 'opened'; }
  if (startup) return;
  // the active tab is only updated after onCreated, but skip t itself in case the order differs
  const ctxTab = (state.active[t.windowId] ?? []).find(id => id !== t.id);
  if (ctxTab == null || ctxTab === openerTab) return;
  const ctx = await c.visit(state.cur[ctxTab]);
  if (ctx) { c.edge(ctx, v, 'context'); if (!opener) v.reason = 'context'; }
}));

chrome.webNavigation.onCreatedNavigationTarget.addListener(d => op('target', async c => {
  const v = await c.visit(state.cur[d.tabId]);
  if (!v) { state.pendingSource[d.tabId] = d.sourceTabId; return; }
  const src = await c.visit(state.cur[d.sourceTabId]);
  if (!src) return;
  const into = await byIndex('edges', 'to', v.id);
  if (into.some(e => e.kind === 'opened')) return;
  c.edge(src, v, 'opened');
  c.put(Object.assign(v, { reason: 'opened' }));
  const dup = into.find(e => e.kind === 'context' && e.from === src.id);
  if (dup) c.dropE.add(dup.id);
}));

chrome.webNavigation.onCommitted.addListener(d => {
  if (d.frameId !== 0 || d.tabId < 0) return;
  op('commit', async c => {
    // prerendered pages commit before the user sees them; record them when the tab actually switches
    if (d.documentLifecycle === 'prerender') {
      state.prerender[d.tabId] = { url: d.url, transition: d.transitionType, qualifiers: d.transitionQualifiers };
      return;
    }
    await navigate(c, d.tabId, d.url, d.transitionType, d.transitionQualifiers);
  });
});

chrome.webNavigation.onHistoryStateUpdated.addListener(d => {
  if (d.frameId !== 0 || d.tabId < 0) return;
  op('history', async c => {
    const prev = await c.visit(state.cur[d.tabId]);
    if (prev && strip(prev.url) === strip(d.url)) return void c.put(Object.assign(prev, { url: d.url }));
    await navigate(c, d.tabId, d.url, 'history', d.transitionQualifiers);
  });
});

chrome.webNavigation.onCompleted.addListener(d => {
  if (d.frameId !== 0 || d.tabId < 0) return;
  op('completed', async c => {
    const [tab, v] = await Promise.all([chrome.tabs.get(d.tabId).catch(() => null), c.visit(state.cur[d.tabId])]);
    if (tab && v) describe(c, v, tab);
  });
});

function describe(c, v, tab) {
  if (tab.url && strip(v.url) !== strip(tab.url)) return;
  let changed = false;
  if (tab.title && tab.title !== v.title) { v.title = tab.title; changed = true; }
  if (tab.favIconUrl && tab.favIconUrl !== v.favIconUrl) { v.favIconUrl = tab.favIconUrl; changed = true; }
  if (changed) c.put(v);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!('title' in info || 'favIconUrl' in info || 'url' in info)) return;
  op('updated', async c => {
    const pr = state.prerender[tabId];
    if (info.url && pr) {
      delete state.prerender[tabId];
      if (pr.url === info.url) await navigate(c, tabId, pr.url, pr.transition, pr.qualifiers);
    }
    const v = await c.visit(state.cur[tabId]);
    if (v) describe(c, v, tab);
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => op('activated', async c => {
  state.active[windowId] = [tabId, ...(state.active[windowId] ?? []).filter(id => id !== tabId)].slice(0, 4);
  const v = await c.visit(state.cur[tabId]);
  if (v) c.put(Object.assign(v, { seen: Date.now(), views: (v.views ?? 0) + 1 }));
}));

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => op('attached', async c => {
  const v = await c.visit(state.cur[tabId]);
  if (v) c.put(Object.assign(v, { windowId: newWindowId }));
}));

chrome.tabs.onRemoved.addListener(tabId => op('removed', async c => {
  const v = await c.visit(state.cur[tabId]);
  if (v) c.put(Object.assign(v, { ended: v.ended ?? Date.now(), closed: Date.now() }));
  for (const m of [state.cur, state.ignore, state.pendingSource, state.prerender]) delete m[tabId];
  for (const w in state.active) state.active[w] = state.active[w].filter(id => id !== tabId);
}));

chrome.windows.onRemoved.addListener(w => op('window-removed', async () => { delete state.active[w]; }));

chrome.tabs.onReplaced.addListener((added, removed) => op('replaced', async c => {
  const v = await c.visit(state.cur[removed]);
  if (v) { c.put(Object.assign(v, { tabId: added })); state.cur[added] = v.id; }
  delete state.cur[removed];
  for (const w in state.active) state.active[w] = state.active[w].map(id => (id === removed ? added : id));
}));

chrome.runtime.onInstalled.addListener(() => op('installed', c => seed(c, 'seed')));

chrome.runtime.onStartup.addListener(() => op('startup', async c => {
  state.session = crypto.randomUUID();
  state.startupAt = Date.now();
  // keep only mappings created by this worker run (events may arrive before onStartup)
  const keep = {};
  for (const [tab, id] of Object.entries(state.cur)) {
    const v = await c.visit(id);
    if (v && v.t >= swStart - 1000) { c.put(Object.assign(v, { session: state.session })); keep[tab] = id; }
  }
  Object.assign(state, { cur: keep, active: {}, ignore: {}, pendingSource: {}, prerender: {} });
  await seed(c, 'restored');
}));

chrome.action.onClicked.addListener(async tab => {
  const open = (await chrome.tabs.query({})).find(t => (t.url || t.pendingUrl || '').startsWith(VIEWER));
  if (!open) return chrome.tabs.create({ url: VIEWER, index: tab.index + 1, windowId: tab.windowId });
  await chrome.tabs.update(open.id, { active: true });
  await chrome.windows.update(open.windowId, { focused: true });
});

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === 'forget') {
    op('forget', async c => {
      for (const id of m.ids) {
        const v = await c.visit(id);
        if (!v) continue;
        await c.drop(v);
        for (const [tab, cur] of Object.entries(state.cur)) if (cur === id) delete state.cur[tab];
      }
    }).then(() => reply(true));
    return true;
  }
  if (m?.type === 'clear') {
    op('clear', async c => {
      await clear();
      state.cur = {};
      await seed(c, 'seed');
    }).then(() => reply(true));
    return true;
  }
});
