// The company test copy's background worker (plan "Empresa de prueba en el teléfono", 2026-11-27). It holds the in-memory backend
// (engine-core.js), answers the app's requests one at a time, and keeps the test copy's Sheet in this phone's IndexedDB between two
// openings. The backend code comes from GitHub (the newest commit on main, the same files the installer uses) and is kept on the
// phone, so later openings are fast and work offline. It never calls Google: the "Google" in here is the in-memory fake.
/* global importScripts, DemoEngineCore, DemoSeed */
const V = self.location.search;   // the app's version (?v=…), so a new deploy never runs with an old engine kept by the browser
importScripts("engine-core.js" + V, "seed.js" + V);

const REPO = "JeanPierreEsR/expense-tracker";
const DB_NAME = "company-test-copy", STORE = "kv";
let engine = null;
let sourcesUrl = "";   // the test server gives its own local files instead of GitHub's (see tests/harness/server.js)

function db_() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function get_(key) {
  const d = await db_();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function put_(key, value) {
  const d = await db_();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, "readwrite");
    if (value === undefined) tx.objectStore(STORE).delete(key); else tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// The newest backend on GitHub, or the copy kept on the phone when it is still the newest (or GitHub cannot be reached).
async function sources_() {
  if (sourcesUrl) {
    const r = await fetch(sourcesUrl, { cache: "no-store" });
    if (!r.ok) throw new Error("test server sources: HTTP " + r.status);
    return r.json();
  }
  const kept = await get_("sources");
  let sha = "";
  try {
    const r = await fetch("https://api.github.com/repos/" + REPO + "/commits?sha=main&per_page=1", { cache: "no-store" });
    if (r.ok) sha = ((await r.json())[0] || {}).sha || "";
  } catch (e) { /* offline: the kept copy is used */ }
  if (kept && (!sha || kept.sha === sha)) return kept;
  if (!sha) throw new Error("offline");
  const list = await fetch("https://api.github.com/repos/" + REPO + "/contents/backend?ref=" + sha);
  if (!list.ok) throw new Error("GitHub file list: HTTP " + list.status);
  const gs = (await list.json()).filter((f) => f.type === "file" && /\.gs$/.test(f.name));
  const raw = (p) => fetch("https://raw.githubusercontent.com/" + REPO + "/" + sha + "/" + p).then((r) => {
    if (!r.ok) throw new Error("GitHub " + p + ": HTTP " + r.status);
    return r.text();
  });
  const [files, fakeGoogle] = await Promise.all([
    Promise.all(gs.map(async (f) => ({ name: f.name, source: await raw("backend/" + f.name) }))),
    raw("tests/harness/fake-google.js")
  ]);
  const out = { sha, files, fakeGoogle };
  await put_("sources", out);
  return out;
}

let saving = Promise.resolve();
function persist_() {
  const snap = engine.snapshot();
  saving = saving.then(() => put_("snapshot", snap)).catch(() => { /* a full phone: the next save tries again */ });
  return saving;
}

// A new test copy: "empty" = a brand-new company copy (its welcome by sector runs); "data" = the made-up company of seed.js.
async function fresh_(start) {
  const src = await sources_();
  engine = DemoEngineCore.create(src);
  if (start === "data") DemoSeed.seed(engine);
  await persist_();
  return src.sha || "";
}

const handlers = {
  async boot(m) {
    sourcesUrl = m.sourcesUrl || "";
    const t0 = Date.now();
    const snap = await get_("snapshot");
    if (snap) {
      const src = await sources_();
      engine = DemoEngineCore.create(src, snap);
      return { fresh: false, ms: Date.now() - t0, sha: src.sha || "" };
    }
    const sha = await fresh_(m.start || "data");
    return { fresh: true, ms: Date.now() - t0, sha };
  },
  async call(m) {
    if (!engine) throw new Error("not started");
    const text = engine.post(m.body);
    if (!/^(get|list)/.test(String(m.action || ""))) persist_();
    return { text };
  },
  async reset(m) {
    await saving;
    await put_("snapshot", undefined);
    const sha = await fresh_(m.start || "data");
    return { fresh: true, sha };
  },
  // "Remove the test copy": its Sheet goes; the downloaded backend stays (it is only code, and saves the next download).
  async wipe() {
    await saving;
    await put_("snapshot", undefined);
    engine = null;
    return {};
  }
};

// One request at a time, in order (the real web app runs them one at a time per copy too).
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data || {};
  queue = queue.then(async () => {
    try { self.postMessage({ id: m.id, ok: true, data: await handlers[m.type](m) }); }
    catch (e) { self.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); }
  });
};
