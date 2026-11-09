// Serves the real frontend (docs/) on http://localhost:4180 wired to the FAKE
// backend (real .gs code + made-up data held in memory). Nothing touches Google,
// Telegram or the owner's real data. In the app, use access code:  test-access-code
//   node tests/harness/server.js            (SEED_ENTRIES=7000 by default)
// POST /__reset re-creates the made-up data from scratch.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { createRuntime, ACCESS_CODE } = require("./gas-runtime");
const { seedData } = require("./seed");

const PORT = Number(process.env.PORT || 4180);
const DOCS = path.join(__dirname, "..", "..", "docs");
const VERSION_AT_START = fs.readFileSync(path.join(DOCS, "version.json"), "utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

let rt, data;
function boot() {
  // EMPTY=1: a brand-new person's copy, built exactly like the installer builds one (the short starter categories and the bank
  // catalogue; the welcome's "What fits me" adds the rest; no accounts, friends or entries).
  rt = createRuntime(process.env.EMPTY ? { installerStart: true, keepFeatures: !!process.env.FRIEND_COPY } : {});
  // The everyday test copies (owner, 2026-11-04): the categories a person gets by ticking EVERY "What fits me" choice (the starter
  // list + one per pick), instead of the owner's own long list. The made-up entries are then spread over these.
  if (!process.env.EMPTY && !process.env.OWNER_CATEGORIES) {
    rt.run(`(function () {
      var sh = getSheet('Categories'); var h = getHeaders(sh); var t = h.indexOf('type');
      var v = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues() : [];
      for (var i = v.length - 1; i >= 0; i--) if (v[i][t] === 'expense' || v[i][t] === 'income') sh.deleteRow(i + 2);
      ROWS_MEMO_ = null;
      applyProfile({ answers: PROFILE_ORDER_, basics: true });
    })()`);
  }
  // EMPTY=1: a brand-new person's copy (only the installer's starter data: categories, banks; no accounts, friends or entries).
  // (the starter seeding has already added the owner's three sample friends, which a copy made by the installer never has)
  if (process.env.EMPTY) rt.sheet("Friends").rows.length = 1;
  data = process.env.EMPTY ? { entries: [], friends: [] } : seedData(rt, { entries: Number(process.env.SEED_ENTRIES || 7000), demoUnreadMail: true });
  // Made-up demo scenarios to try the newest features by hand (friends to delete/hide, programmed items in every state, legacy paused items for the
  // heal). NO_DEMO=1 leaves them out. The automated tests never go through this file.
  if (!process.env.NO_DEMO && !process.env.EMPTY) require("./demo-data").seedDemo(rt, data);
  // USD_RATES_ONLY=1: the owner-style copy keeps only its dollar rates (a copy whose move to the dollar changes nothing visible).
  if (process.env.USD_RATES_ONLY) {
    const rates = rt.sheet("Exchange Rates").rows, col = rates[0].indexOf("currency");
    rates.splice(0, rates.length, ...rates.filter((r, i) => i === 0 || String(r[col]).toUpperCase() === "USD"));
  }
  // Export data: mail goes nowhere here; GET /__mail lists what "would have been" sent.
  rt.api("admin_setExportEmail", { email: "owner@example.com" });
  // FRIEND_COPY=1 behaves like an app made by the installer (FEATURES set), e.g. to check what a new person does not see.
  if (process.env.FRIEND_COPY) rt.svc.props.set("FEATURES", "gmail,keepawake");
  // SHEET_TZ=UTC: the Sheet's own time zone differs from the script's (America/Lima), like a friend's Sheet made by the installer.
  // SHEET_DATES=1: Sheets turns written date strings into real dates (as it does on a real Sheet) instead of keeping them as text.
  if (process.env.SHEET_TZ) require("./fake-google").setSheetTimeZone(process.env.SHEET_TZ);
  if (process.env.SHEET_DATES) rt.svc.ss.getSheets().forEach((sh) => sh.textCols && sh.textCols.clear());
}
boot();

http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (req.method === "POST" && url === "/api") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const readsBefore = rt.stats.reads, cellsBefore = rt.stats.cellsRead;
      const reply = rt.rawPost(body);
      // SLOW=1: answer as late as the real backend does on a phone (fitted to the owner's speed log, 2026-10: ~2.3 s per
      // trip to Google, ~0.1 s per read call, ~10 ms per 1,000 cells read), to feel and time waits the instant fake hides.
      const wait = process.env.SLOW ? 2300 + 100 * (rt.stats.reads - readsBefore) + (rt.stats.cellsRead - cellsBefore) / 100 : 0;
      setTimeout(() => {
        // Open to other localhost pages, like the real web app is: a second harness (a friend's copy) reports app speed to this one.
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(reply));
      }, wait);
    });
    return;
  }
  if (req.method === "POST" && url === "/__reset") { boot(); res.end("reset"); return; }
  // Opening http://<this computer>:<port>/login signs this browser in to the test copy (the real sign-in text only accepts "localhost").
  // FRIEND_COPY also sets a full web address for the fake backend: the page rewrite below makes the owner's address "/api", and a copy using exactly that
  // counts as the OWNER's (perfIsOwnerCopy_), which hid Feedback & privacy and every other friends-only row on the friend-style copy.
  if (url === "/login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px -apple-system,sans-serif;padding:24px">Signing in to the test copy…<script>localStorage.setItem("accessCode", ${JSON.stringify(ACCESS_CODE)}); localStorage.setItem("etChannel", "live"); if (!localStorage.getItem("lang") && /^es/i.test(navigator.language || "")) localStorage.setItem("lang", "es"); ${process.env.FRIEND_COPY ? 'localStorage.setItem("apiUrl", location.origin + "/api");' : ""} ${process.env.POP_MONTH_OLD ? 'localStorage.setItem("popFirstUse", JSON.stringify(new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10))); (function(){var n=new Date(),day=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0")+"-"+String(n.getDate()).padStart(2,"0");localStorage.setItem("tipCardsToday",JSON.stringify({day:day,keys:[],open:true}));})(); localStorage.setItem("popTipsAgain","true"); localStorage.setItem("popTipsSeen","[]"); localStorage.removeItem("popTipDay");' : ""} ${process.env.REAL_NEW ? 'localStorage.setItem("etOnboarded","1"); localStorage.setItem("tutorialAgain","true"); localStorage.setItem("tutorialTaughtOld","[]"); localStorage.setItem("tutorialTaught","{}"); localStorage.setItem("tutorialChances","{}"); localStorage.setItem("tutorialReviewTypes","[]"); localStorage.setItem("tutorialFields",JSON.stringify(["category","amount","currency","description","date","account"])); localStorage.setItem("tipsSeen",JSON.stringify(["guided-entry"]));' : ""} localStorage.removeItem("startupCache"); location.replace("/");</script>`);
    return;
  }
  if (url === "/__mail") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rt.svc.mailLog.map((m) => ({ to: m.to, subject: m.subject, body: m.body, attachments: m.attachments.map((a) => ({ name: a.name, chars: a.data.length, head: a.data.slice(0, 300) })) }))));
    return;
  }
  if (req.method === "POST" && url === "/__addmail") {   // drops a made-up e-mail into the fake Gmail: {from, subject, body, daysAgo}
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { rt.svc.gmail.addEmail(JSON.parse(body)); res.end("added"); });
    return;
  }
  if (req.method === "POST" && url === "/__typerow") {   // a row typed by hand in the fake Sheet: {sheet, fields}
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { sheet, fields } = JSON.parse(body);
      const tab = rt.svc.ss.getSheetByName(sheet);
      tab.rows.push(tab.rows[0].map((h) => (fields[h] !== undefined ? fields[h] : "")));
      res.end("typed");
    });
    return;
  }
  // An entry waiting in Needs review, as if a bank e-mail had brought it (the app's own saves are always confirmed):
  // {description, amount, currency?, category? (name or id), date? (YYYY-MM-DD, default today), type? (default expense)}.
  if (req.method === "POST" && url === "/__pending") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = JSON.parse(body || "{}");
      const cat = rt.rows("Categories").find((c) => c.id === f.category || c.name === f.category);
      const pm = rt.rows("Payment Methods")[0];
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
      const row = { id: "pending-" + Date.now() + "-" + Math.floor(Math.random() * 1e6), type: f.type || "expense", date: f.date || today,
        amount: Number(f.amount || 10), currency: f.currency || "PEN", category_id: cat ? cat.id : "", description: f.description || "Test pending",
        paid_by: "me", payment_method_id: pm ? pm.id : "", status: "pending", source: "email" };
      rt.run(`appendRowObject('Entries', ${JSON.stringify(row)});`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(row));
    });
    return;
  }
  // version.json is frozen at start-up: a ship by another chat while a test copy is open used to show the "tap to reload" banner
  // on it (seen by the testers, 2026-11-07), though the fake backend here keeps the code it started with. LIVE_VERSION=1 serves the real file.
  if (url === "/version.json" && !process.env.LIVE_VERSION) {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(VERSION_AT_START);
    return;
  }
  if (url === "/__samples") {   // the rows the owner's Sheet would hold in its "Bank Samples" tab
    res.writeHead(200, { "Content-Type": "application/json" });
    let rows = [];
    try { rows = rt.rows("Bank Samples"); } catch (e) { /* no sample has arrived yet */ }
    res.end(JSON.stringify(rows));
    return;
  }
  if (url === "/__statementsamples") {   // the rows the owner's Sheet would hold in its "Statement Samples" tab
    res.writeHead(200, { "Content-Type": "application/json" });
    let rows = [];
    try { rows = rt.rows("Statement Samples"); } catch (e) { /* no sample has arrived yet */ }
    res.end(JSON.stringify(rows.map((r) => ({ ...r, text: String(r.text).slice(0, 400) + " […]" }))));
    return;
  }
  if (url === "/__perf") {   // the rows the owner's Sheet would hold in its "Perf Reports" tab
    res.writeHead(200, { "Content-Type": "application/json" });
    let rows = [];
    try { rows = rt.rows("Perf Reports"); } catch (e) { /* no report has arrived yet */ }
    res.end(JSON.stringify(rows));
    return;
  }
  if (url === "/__beta") {   // the rows the owner's Sheet would hold in its "Beta Events" tab
    res.writeHead(200, { "Content-Type": "application/json" });
    let rows = [];
    try { rows = rt.rows("Beta Events"); } catch (e) { /* no count has arrived yet */ }
    res.end(JSON.stringify(rows));
    return;
  }
  if (url === "/__feedback") {   // the rows the owner's Sheet would hold in its "Feedback" tab
    res.writeHead(200, { "Content-Type": "application/json" });
    let rows = [];
    try { rows = rt.rows("Feedback"); } catch (e) { /* no note has arrived yet */ }
    res.end(JSON.stringify(rows));
    return;
  }
  if (url === "/__info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accessCode: ACCESS_CODE, friends: data.friends.map((f) => f.name) }));
    return;
  }
  let file = path.join(DOCS, url === "/" ? "index.html" : url);
  if (file.startsWith(DOCS) && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");   // /stable/ and /setup/ open their index.html, like GitHub Pages
  if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  let buf = fs.readFileSync(file);
  if (path.basename(file) === "app.js") {
    // Point the app at the fake backend instead of the real Apps Script URL.
    buf = Buffer.from(buf.toString().replace(/const OWNER_API_URL = "[^"]*";/, 'const OWNER_API_URL = "/api";'));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(buf);
}).listen(PORT, () => console.log(`Fake app on http://localhost:${PORT}  (access code: ${ACCESS_CODE}) — ${data.entries.length} made-up entries`));
