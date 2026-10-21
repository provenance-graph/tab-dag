// IndexedDB shared by the service worker (writer) and the viewer (reader).
// visits: one record per page view; edges: parent visit -> child visit, always older -> newer.
const NAME = 'provenance';
const VERSION = 1;
const STORES = ['visits', 'edges'];

let dbp;
export function db() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const v = d.createObjectStore('visits', { keyPath: 'id' });
      v.createIndex('url', 'url');
      const e = d.createObjectStore('edges', { keyPath: 'id' });
      e.createIndex('from', 'from');
      e.createIndex('to', 'to');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

const done = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function getAll(store) {
  return done((await db()).transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  return done((await db()).transaction(store).objectStore(store).get(key));
}

export async function byIndex(store, index, key) {
  return done((await db()).transaction(store).objectStore(store).index(index).getAll(key));
}

// fn receives { visits, edges } object stores of a single readwrite transaction
export async function write(fn) {
  const t = (await db()).transaction(STORES, 'readwrite');
  fn({ visits: t.objectStore('visits'), edges: t.objectStore('edges') });
  return new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function clear() {
  return write(s => { s.visits.clear(); s.edges.clear(); });
}
