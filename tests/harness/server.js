// Serves the real frontend (docs/) on http://localhost:4180 wired to the FAKE
// backend (real .gs code + made-up data held in memory). Nothing touches Google,
// Telegram or the owner's real data. In the app, use access code:  test-access-code
//   node tests/harness/server.js            (SEED_ENTRIES=7000 by default)
// POST /__reset re-creates the made-up data from scratch.
const http = require("http");
const fs = require("fs");
const path = require("path");
// TIME_TRAVEL=1 (2026-11-17): "now" is whatever the tester sets with POST /__clock, for the fake backend AND the phone (a small script
// at the top of every page); CLOCK_START=YYYY-MM-DD[THH:MM] (Lima) picks the first day. Installed before the backend is loaded.
const clock = require("./clock");
const TIME_TRAVEL = !!process.env.TIME_TRAVEL;
if (TIME_TRAVEL) { clock.install(); if (process.env.CLOCK_START) clock.setNow(clock.limaMs(process.env.CLOCK_START)); }
const channels = require("./channels");
const { createRuntime, ACCESS_CODE } = require("./gas-runtime");
const { seedData } = require("./seed");

// COMPANY_COPY=1: a brand-new company copy is a brand-new friend's copy plus the company mark (see boot()).
if (process.env.COMPANY_COPY) { process.env.EMPTY = "1"; process.env.FRIEND_COPY = "1"; }
const PORT = Number(process.env.PORT || 4180);
const DOCS = path.join(__dirname, "..", "..", "docs");
const VERSION_AT_START = fs.readFileSync(path.join(DOCS, "version.json"), "utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

let rt, data, world;
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
  // No Yape / Plin accounts on the test copies (owner, 2026-11-14): in the app they show next to their bank account, never as an
  // account of their own. Their made-up entries move to "Main debit". KEEP_WALLETS=1 keeps them. (The automated tests keep their own seed.)
  if (!process.env.EMPTY && !process.env.KEEP_WALLETS) {
    const pmRows = rt.sheet("Payment Methods").rows, ph = pmRows[0];
    const wallets = new Set(pmRows.slice(1).filter((r) => r[ph.indexOf("type")] === "wallet").map((r) => r[ph.indexOf("id")]));
    const main = pmRows.slice(1).find((r) => r[ph.indexOf("nickname")] === "Main debit");
    if (wallets.size && main) {
      const mainId = main[ph.indexOf("id")];
      rt.svc.ss.getSheets().forEach((sh) => {
        if (!sh.rows || !sh.rows.length || sh === rt.sheet("Payment Methods")) return;
        const cols = sh.rows[0].map((c, i) => (/payment_method_id$/.test(String(c)) ? i : -1)).filter((i) => i >= 0);
        if (cols.length) sh.rows.slice(1).forEach((r) => cols.forEach((i) => { if (wallets.has(r[i])) r[i] = mainId; }));
      });
      pmRows.splice(0, pmRows.length, ...pmRows.filter((r, i) => i === 0 || !wallets.has(r[ph.indexOf("id")])));
    }
  }
  // USD_RATES_ONLY=1: the owner-style copy keeps only its dollar rates (a copy whose move to the dollar changes nothing visible).
  if (process.env.USD_RATES_ONLY) {
    const rates = rt.sheet("Exchange Rates").rows, col = rates[0].indexOf("currency");
    rates.splice(0, rates.length, ...rates.filter((r, i) => i === 0 || String(r[col]).toUpperCase() === "USD"));
  }
  // BUBBLE_EXTRAS=1 (owner, 2026-11-12): what the bubbles of batches D/E need and the demo lacks. The Business pack is offered and on
  // (receipt photos), "Travel card" only charges in USD (a PEN expense opens the charged-amount box by itself) and "Shop card" in PEN and
  // USD (the "Listed price in another currency?" link), "Daily debit" (Interbank) has a PEN starting balance (its balance window: starting
  // balances, payments in process), and the rates go through the dollar (the dollar line under third-currency entries). Runs before
  // FRIEND_COPY marks the copy as a friend's (moving the rates to the dollar is refused there).
  if (process.env.BUBBLE_EXTRAS) {
    rt.run(`(function () {
      setSetting_('business_offered', 'yes'); setSetting_('business_features', 'yes');
      var sh = getSheet('Payment Methods'); var h = getHeaders(sh); var v = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
      var col = function (n) { return h.indexOf(n) + 1; };
      var start = new Date(); start.setFullYear(start.getFullYear() - 1);
      var startDay = Utilities.formatDate(start, 'America/Lima', 'yyyy-MM-dd');
      v.forEach(function (r, i) {
        var row = i + 2, name = r[h.indexOf('nickname')];
        if (name === 'Travel card') sh.getRange(row, col('currencies')).setValue('USD');
        if (name === 'Shop card') sh.getRange(row, col('currencies')).setValue('PEN,USD');
        if (name === 'Daily debit') {
          sh.getRange(row, col('opening_balance')).setValue(5000);
          sh.getRange(row, col('opening_balance_date')).setValue(startDay);
          sh.getRange(row, col('opening_balance_currency')).setValue('PEN');
        }
      });
      ROWS_MEMO_ = null;
      convertRatesToUsd();
    })()`);
  }
  // ANNUAL_DEMO=1 (2026-11-14): an owner-style "Annual budget" category (key annual_budget) holding some made-up expenses (a flight
  // booked twice, a TV, one with no description, one waiting in Needs review) and a yearly budget on it, to try the owner's one-time
  // clean-up card in More → My data → Tidy my history (AnnualCleanup.gs). Owner's copy only (not with FRIEND_COPY).
  if (process.env.ANNUAL_DEMO) {
    rt.run(`(function () {
      appendRowObject('Categories', { id: 'demo-annual-budget', key: 'annual_budget', name: 'Annual budget', type: 'expense', icon: '🗓️', color: '#8E7CC3', parent_id: '' });
      var day = function (back) { var d = new Date(); d.setDate(d.getDate() - back); return Utilities.formatDate(d, 'America/Lima', 'yyyy-MM-dd'); };
      [['Demo Air Lima-Cusco', 820, 40, 'confirmed'], ['Demo Air Lima-Cusco', 760, 200, 'confirmed'], ['Demo TV store', 2400, 25, 'confirmed'],
       ['', 150, 10, 'confirmed'], ['Demo hotel Cusco', 600, 3, 'pending']].forEach(function (r, i) {
        appendRowObject('Entries', { id: 'demo-ab-' + i, type: 'expense', date: day(r[2]), amount: r[1], currency: 'PEN', category_id: 'demo-annual-budget',
          description: r[0], paid_by: 'me', status: r[3], source: 'manual' });
      });
      ROWS_MEMO_ = null;
      addBudget({ category_id: 'demo-annual-budget', amount: 12000, currency: 'PEN', period_type: 'yearly', start: 'always' });
    })()`);
  }
  // Export data: mail goes nowhere here; GET /__mail lists what "would have been" sent.
  rt.api("admin_setExportEmail", { email: "owner@example.com" });
  // FRIEND_COPY=1 behaves like an app made by the installer (FEATURES set), e.g. to check what a new person does not see.
  if (process.env.FRIEND_COPY) rt.svc.props.set("FEATURES", "gmail,keepawake");
  // COMPANY_COPY=1 (Business 2, piece 1): a brand-new COMPANY copy (it implies EMPTY=1 and FRIEND_COPY=1, set at the top of this file),
  // marked the way the owner marks a real one: the Settings row company_copy = yes. Its welcome asks the sector, the company and its projects.
  if (process.env.COMPANY_COPY) rt.run("setSetting_('company_copy', 'yes')");
  // SHEET_TZ=UTC: the Sheet's own time zone differs from the script's (America/Lima), like a friend's Sheet made by the installer.
  // SHEET_DATES=1: Sheets turns written date strings into real dates (as it does on a real Sheet) instead of keeping them as text.
  if (process.env.SHEET_TZ) require("./fake-google").setSheetTimeZone(process.env.SHEET_TZ);
  if (process.env.SHEET_DATES) rt.svc.ss.getSheets().forEach((sh) => sh.textCols && sh.textCols.clear());
  // Bank e-mails at a chosen moment and the Telegram / WhatsApp bots as a chat (channels.js); Telegram's and Meta's servers are imitated.
  world = channels.attach(rt);
}
boot();

// The 15-minute timer of a real copy (runAutomation: e-mails, bots, budget alerts, loan reminders...). While the clock is moved
// forward it runs every 2 hours from 07:00 to 23:00 Lima time, with the e-mails due by then delivered first.
const JOB_HOURS = [7, 9, 11, 13, 15, 17, 19, 21, 23];
function runJobs(log) {
  world.deliverDue();
  try { rt.run("runAutomation()"); log.jobs++; } catch (e) { log.errors.push(clock.limaText(clock.now()) + " " + e.message); }
}
function advanceTo(target, jobs) {
  const log = { from: clock.limaText(clock.now()), jobs: 0, errors: [] };
  if (target < clock.now()) throw new Error("The clock only moves forward in a journey (now " + log.from + ")");
  if (jobs) {
    // Every job moment between now and the target, in order.
    const day0 = clock.limaMs(clock.limaText(clock.now()).slice(0, 10) + "T00:00");
    for (let d = day0; d <= target; d += 86400000) {
      JOB_HOURS.forEach((h) => {
        const at = d + h * 3600000;
        if (at > clock.now() && at <= target) { clock.setNow(at); runJobs(log); }
      });
    }
  }
  clock.setNow(target);
  world.deliverDue();
  log.to = clock.limaText(clock.now());
  return log;
}
function clockInfo() {
  return { timeTravel: TIME_TRAVEL, now: clock.now(), lima: clock.limaText(clock.now()), offsetDays: Math.round(clock.offset() / 864000) / 100, mailWaiting: world.mailQueue.length };
}
const readBody = (req, done) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => done(b ? JSON.parse(b) : {})); };
const sendJson = (res, obj, code) => { res.writeHead(code || 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

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
    res.end(`<!doctype html>${TIME_TRAVEL ? clock.browserSnippet() : ""}<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px -apple-system,sans-serif;padding:24px">Signing in to the test copy…<script>localStorage.setItem("accessCode", ${JSON.stringify(ACCESS_CODE)}); localStorage.setItem("etChannel", "live"); if (!localStorage.getItem("lang") && /^es/i.test(navigator.language || "")) localStorage.setItem("lang", "es"); ${process.env.FRIEND_COPY ? 'localStorage.setItem("apiUrl", location.origin + "/api");' : ""} ${process.env.POP_MONTH_OLD ? 'localStorage.setItem("popFirstUse", JSON.stringify(new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10))); (function(){var n=new Date(),day=n.getFullYear()+"-"+String(n.getMonth()+1).padStart(2,"0")+"-"+String(n.getDate()).padStart(2,"0");localStorage.setItem("tipCardsToday",JSON.stringify({day:day,keys:[],open:true}));})(); localStorage.setItem("popTipsAgain","true"); localStorage.setItem("popTipsSeen","[]"); localStorage.removeItem("popTipDay"); localStorage.setItem("popTipSeries","{}"); localStorage.setItem("projUnlockedOn", JSON.stringify(new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10))); localStorage.removeItem("projMethodUsed"); localStorage.setItem("tutorialIdleSeen","[]"); (function(){var a=[];for(var i=1;i<=8;i++){var d=new Date(Date.now()-i*86400000);a.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"));}localStorage.setItem("popActiveDays",JSON.stringify(a.reverse()));})(); localStorage.setItem("popEntrySaves","40"); localStorage.setItem("popManualRun","3"); localStorage.setItem("tipNotNowCount","2"); localStorage.setItem("popTipVisits",JSON.stringify({overview:2,projections:2})); ["popMonthTapped","popStats","popStruggle","popOneDeletes","popUsedBefore"].forEach(function(k){localStorage.removeItem(k);});' : ""} ${process.env.SKIP_WELCOME ? 'localStorage.setItem("etOnboarded","1");' : ""} ${process.env.REAL_NEW ? 'localStorage.setItem("etOnboarded","1"); localStorage.setItem("tutorialAgain","true"); localStorage.setItem("tutorialTaughtOld","[]"); localStorage.setItem("tutorialTaught","{}"); localStorage.setItem("tutorialChances","{}"); localStorage.setItem("tutorialIdleSeen","[]"); localStorage.removeItem("tidyTapAsked"); localStorage.removeItem("noacctTapAsked"); localStorage.setItem("tutorialReviewTypes","[]"); localStorage.setItem("tutorialFields",JSON.stringify(["category","amount","currency","description","date","account"])); localStorage.setItem("tipsSeen",JSON.stringify(["guided-entry"]));' : ""} localStorage.removeItem("startupCache"); location.replace("/");</script>`);
    return;
  }
  // ---- Time travel and the outside world (journeys, 2026-11-17; tests/README.md § Journeys) ----
  // GET /__clock: what time it is on this copy. POST /__clock {to: "2027-01-05T09:00" | days | hours | minutes, jobs: true}: moves
  // "now" forward, running the copy's timer and delivering the e-mails due on the way. The phone must reload (or call
  // window.__tt.set(now)) to follow; the journey runner does that.
  if (url === "/__clock") {
    if (req.method !== "POST") { sendJson(res, clockInfo()); return; }
    readBody(req, (b) => {
      try {
        if (!TIME_TRAVEL) throw new Error("Start the server with TIME_TRAVEL=1 to move the clock");
        const target = b.to ? clock.limaMs(b.to) : clock.now() + ((b.days || 0) * 24 * 60 + (b.hours || 0) * 60 + (b.minutes || 0)) * 60000;
        sendJson(res, { ...advanceTo(target, b.jobs !== false), ...clockInfo() });
      } catch (e) { sendJson(res, { error: e.message }, 400); }
    });
    return;
  }
  // POST /__jobs: run the timer once now (e-mails, bots, alerts), as a 15-minute tick would.
  if (req.method === "POST" && url === "/__jobs") { const log = { jobs: 0, errors: [] }; runJobs(log); sendJson(res, log); return; }
  // POST /__bankmail: one e-mail or a list, [{kind, amount, currency?, merchant, last4?, at?}] (kinds: channels.js BANK_MAIL) or
  // {from, subject, body, at?}; `at` (Lima "YYYY-MM-DDTHH:MM") in the future waits in a queue until the clock reaches it.
  if (req.method === "POST" && url === "/__bankmail") {
    readBody(req, (b) => { try { sendJson(res, { delivered: world.queueMail([].concat(b)), waiting: world.mailQueue.length }); } catch (e) { sendJson(res, { error: e.message }, 400); } });
    return;
  }
  // POST /__bots {telegram: true} — a Telegram bot token is saved (as the Sheet menu does; the person links the chat by sending
  // "/start <access code>"); {whatsapp: true} — this copy is one the owner marked for the WhatsApp bot (the person turns it on in
  // More → My profile → WhatsApp bot).
  if (req.method === "POST" && url === "/__bots") {
    readBody(req, (b) => { const out = {}; if (b.telegram) out.telegram = world.telegramSetUp(); if (b.whatsapp) out.whatsapp = world.whatsappOffer(); sendJson(res, out); });
    return;
  }
  // POST /__chat {bot: "telegram"|"whatsapp", text} or {bot, tap: "<button title or id>", to?: <message id>}: the person writes to
  // (or taps a button of) the bot. GET /__chat?since=<n>: the conversation, from line n. GET /chat: the same as a page.
  if (url === "/__chat") {
    if (req.method !== "POST") {
      const since = Number((/since=(\d+)/.exec(req.url) || [])[1] || 0);
      sendJson(res, world.chat.slice(since).map((c, i) => ({ n: since + i, when: clock.limaText(c.at), ...c, at: undefined })));
      return;
    }
    readBody(req, (b) => {
      const before = world.chat.length;
      try {
        if (b.bot === "telegram") world.telegramSend(b); else if (b.bot === "whatsapp") world.whatsappSend(b); else throw new Error("bot must be telegram or whatsapp");
        sendJson(res, world.chat.slice(before).map((c, i) => ({ n: before + i, when: clock.limaText(c.at), ...c, at: undefined })));
      } catch (e) { sendJson(res, { error: e.message }, 400); }
    });
    return;
  }
  if (url === "/chat") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(__dirname, "chat.html")));
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
  if (TIME_TRAVEL && path.extname(file) === ".html") buf = Buffer.from(buf.toString().replace(/<head>/i, "<head>" + clock.browserSnippet()));
  if (path.basename(file) === "app.js") {
    // Point the app at the fake backend instead of the real Apps Script URL.
    buf = Buffer.from(buf.toString().replace(/const OWNER_API_URL = "[^"]*";/, 'const OWNER_API_URL = "/api";'));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(buf);
}).listen(PORT, () => console.log(`Fake app on http://localhost:${PORT}  (access code: ${ACCESS_CODE}) — ${data.entries.length} made-up entries`));
