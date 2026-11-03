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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

let rt, data;
function boot() {
  rt = createRuntime();
  data = seedData(rt, { entries: Number(process.env.SEED_ENTRIES || 7000), demoUnreadMail: true });
  // Made-up demo scenarios to try the newest features by hand (friends to delete/hide, programmed items in every state, legacy paused items for the
  // heal). NO_DEMO=1 leaves them out. The automated tests never go through this file.
  if (!process.env.NO_DEMO) require("./demo-data").seedDemo(rt, data);
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
  if (url === "/login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px -apple-system,sans-serif;padding:24px">Signing in to the test copy…<script>localStorage.setItem("accessCode", ${JSON.stringify(ACCESS_CODE)}); localStorage.setItem("etChannel", "live"); localStorage.removeItem("startupCache"); location.replace("/");</script>`);
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
