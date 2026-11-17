#!/usr/bin/env node
// Journeys (2026-11-17): a made-up person (personas.js) lives through months of the app on a test copy whose clock moves forward.
// One persona = its own test copy (fake backend, TIME_TRAVEL) + its own "phone" (a headless iPhone browser that stays open, so a
// tutorial can be followed tap by tap) + a folder with its files, screenshots, the teaching ledger and the journal.
//
//   node tests/journey/j.js start <persona>        start the copy and the phone (signs in; the welcome screens are next)
//   node tests/journey/j.js <persona> look         what the phone shows: where, teaching on screen, visible text, numbered buttons, screenshot
//   node tests/journey/j.js <persona> tap "<text>" | tap 12 | tap --at 200,300     a finger tap (by visible text, by number from look, or a point)
//   node tests/journey/j.js <persona> fill "<field label or number>" "<text>"     tap a box and type into it
//   node tests/journey/j.js <persona> type "<text>" | key Enter | scroll down|up [px] | wait <seconds> | reload | back
//   node tests/journey/j.js <persona> upload <file in the persona's files/> "<button that opens the file chooser>"
//   node tests/journey/j.js <persona> live [--days N | --until YYYY-MM-DD]    the routine days: the clock moves, bank e-mails arrive,
//        the person opens the app on the days they would and types the purchases they would; it STOPS when the app teaches
//        something (a tutorial, bubble, card, question, the welcome) so the tester handles it, or at the end of the range
//   node tests/journey/j.js <persona> chat whatsapp|telegram "<text>" | chat-tap whatsapp|telegram "<button>" | chatlog
//   node tests/journey/j.js <persona> clock | ledger | memory | brief | note "<text>" | files | phone-restart | stop
// Folder: $JOURNEY_ROOT/<run>/<persona> (JOURNEY_ROOT default ~/journeys, JOURNEY_RUN default "pilot").
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const life = require("./life");
const PERSONAS = require("./personas");
const F = require("./files");

const REPO = path.join(__dirname, "..", "..");
const ROOT = path.join(process.env.JOURNEY_ROOT || path.join(os.homedir(), "journeys"), process.env.JOURNEY_RUN || "pilot");
const PW = process.env.PLAYWRIGHT_DIR || path.join(os.homedir(), ".expense-tracker-tools", "node_modules", "playwright");

const persona = (id) => { const p = PERSONAS.find((x) => x.id === id); if (!p) throw new Error("No persona " + id + " (" + PERSONAS.map((x) => x.id).join(", ") + ")"); return p; };
const ports = (p) => { const i = PERSONAS.indexOf(p); return { app: 4400 + i * 2, phone: 4401 + i * 2 }; };
const dirOf = (p) => path.join(ROOT, p.id);
const stateFile = (p) => path.join(dirOf(p), "state.json");
const readState = (p) => { try { return JSON.parse(fs.readFileSync(stateFile(p), "utf8")); } catch (e) { return {}; } };
const writeState = (p, s) => fs.writeFileSync(stateFile(p), JSON.stringify(s, null, 2));
const RealDate = Date;

function req(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, method, path: url, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { try { resolve(JSON.parse(t)); } catch (e) { resolve(t); } });
    });
    r.on("error", reject);
    r.setTimeout(30 * 60 * 1000);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limaDay = (ms) => new RealDate(ms - 5 * 3600000).toISOString().slice(0, 10);

// ---------- the files a persona brings on day 1 ----------
const CAT_NAMES = {   // how each source names a category key
  spendee: { groceries: "Groceries", restaurants: "Food & Drink", transport: "Transport", home: "Bills", going_out: "Entertainment", health: "Health", shopping: "Shopping", subscriptions: "Subscriptions", salary: "Salary", other: "Other" },
  wallet: { groceries: "Groceries", restaurants: "Restaurant, fast-food", transport: "Taxi", home: "Energy, utilities", going_out: "Bar, cafe", health: "Drug-store, chemist", shopping: "Clothes & shoes", subscriptions: "Software, apps, games", salary: "Wage, invoices", other: "Others" },
  moneymanager: { groceries: "Food", restaurants: "Food", transport: "Transportation", home: "Household", going_out: "Social Life", health: "Health", shopping: "Apparel", subscriptions: "Culture", salary: "Salary", other: "Other" },
  homemade: { groceries: "Mercado", restaurants: "Comida", transport: "Taxi", home: "Casa", going_out: "Salidas", health: "Salud", shopping: "Ropa", subscriptions: "Suscripciones", salary: "Sueldo", other: "Otros" }
};
function makeFiles(p) {
  const out = path.join(dirOf(p), "files");
  fs.mkdirSync(out, { recursive: true });
  const b = p.bring;
  if (!b) return [];
  const made = [];
  const acct = Object.fromEntries((p.accounts || []).map((a) => [a.id, a]));
  if (b.kind !== "statements") {
    const from = life.addDays(p.clockStart, -Math.round(b.months * 30.4)), to = life.addDays(p.clockStart, -1);
    const names = CAT_NAMES[b.kind === "monefy" ? "spendee" : b.kind];
    const entries = life.days(p, from, to).map((t) => ({ date: t.date, time: t.time, type: t.type, amount: t.amount, currency: t.currency,
      category: names[t.cat] || names.other, description: t.merchant, account: t.via === "cash" ? (p.lang === "es" ? "Efectivo" : "Cash") : t.via === "yape" ? "Yape" : (acct[t.via] ? acct[t.via].bank + " " + acct[t.via].last4 : t.via) }));
    const file = { spendee: ["spendee.csv", () => F.spendeeCsv(entries)], wallet: ["wallet.csv", () => F.walletCsv(entries)], monefy: ["monefy.csv", () => F.monefyCsv(entries)],
      moneymanager: ["money-manager.xlsx", () => F.moneyManagerXlsx(entries)], homemade: ["mis-gastos.xlsx", () => F.homemadeXlsx(entries)] }[b.kind];
    fs.writeFileSync(path.join(out, file[0]), file[1]());
    made.push(file[0] + " (" + entries.length + " lines, " + from + " to " + to + ")");
    return made;
  }
  // Statements: the last full month before the journey (a card: the cycle that closed on the 26th of it).
  const y = +p.clockStart.slice(0, 4), m = +p.clockStart.slice(5, 7);
  b.files.forEach((f) => {
    const st = statement(p, f.layout, acct[f.account] || {}, y, m - 1);
    fs.writeFileSync(path.join(out, st.file), st.buf);
    made.push(st.file + " (" + st.lines + " lines, " + st.start + " to " + st.end + ")");
  });
  return made;
}

// One month's statement of one account, made from the persona's life: month `mo` (1-12, may be 0 or 13: the year rolls).
// Savings: the calendar month. A card: the cycle from the 27th of the month before to the 26th.
function statement(p, layout, a, year, mo) {
  const first = new RealDate(RealDate.UTC(year, mo - 1, 1)).toISOString().slice(0, 10);
  const last = new RealDate(RealDate.UTC(year, mo, 0)).toISOString().slice(0, 10);
  const card = /Card/.test(layout);
  const start = card ? life.addDays(first, -4) : first, end = card ? life.addDays(last, -4) : last;
  const r = life.rng(p.id + "stmt" + first + a.id);
  let lines = life.days(p, start, end).filter((t) => t.via === a.id).map((t) => ({ date: t.date, description: t.merchant.toUpperCase(), amount: t.type === "income" ? t.amount : -t.amount, currency: t.currency }));
  if (card) lines = [{ date: life.addDays(start, 8), description: "PAGO BANCA MOVIL", amount: 600, currency: "PEN" }].concat(lines);
  else {
    // A savings account also shows paying the person's cards and taking out cash.
    lines = lines.filter((l) => l.currency === "PEN");
    (p.accounts || []).filter((c) => c.type === "credit").forEach((c, i) => lines.push({ date: life.addDays(start, 9 + i * 3), description: "PAGO TARJETA " + c.bank.toUpperCase() + " " + c.last4, amount: -Math.round(400 + r() * 900), currency: "PEN" }));
    if (p.habits.some((h) => (h.via || "cash") === "cash")) [6, 20].forEach((n) => lines.push({ date: life.addDays(start, n), description: "RETIRO CAJERO", amount: -Math.round(150 + r() * 250), currency: "PEN" }));
    lines.sort((x, z) => x.date.localeCompare(z.date));
  }
  const holder = p.first.toUpperCase() + " PRUEBA*";
  const opening = Math.round(800 + r() * 4000);
  const name = { bcpSavings: "bcp-ahorros", bcpCard: "bcp-visa", interbankSavings: "interbank-ahorros", interbankCard: "interbank-visa", bbvaMovements: "bbva-movimientos", scotiabankMovements: "scotiabank-movimientos" }[layout];
  let buf, ext = "pdf";
  if (layout === "bcpSavings") buf = F.bcpSavingsPdf({ holder, code: a.code || "191-00000000-0-00", start, end, opening, lines });
  if (layout === "interbankSavings") buf = F.interbankSavingsPdf({ holder, number: a.number || "200-3000000000", start, end, opening, lines });
  if (layout === "bcpCard") buf = F.bcpCardPdf({ holder, last4: a.last4, start, end, previous: { PEN: 1200, USD: 0 }, lines });
  if (layout === "interbankCard") buf = F.interbankCardPdf({ holder, last4: a.last4, start, end, previous: { PEN: 1200, USD: 0 }, lines });
  if (layout === "bbvaMovements") { buf = F.bbvaMovementsXlsx({ lines }); ext = "xlsx"; }
  if (layout === "scotiabankMovements") { buf = Buffer.from(F.scotiabankMovementsCsv({ lines })); ext = "csv"; }
  return { buf, file: `${name}-${first.slice(0, 7)}.${ext}`, lines: lines.length, start, end };
}

// The statements the person's banks e-mail every month (only layouts the app reads, from the addresses the app knows):
// a card's two days after its cycle closes (the 28th), a savings account's on the 3rd for the month before.
const STATEMENT_SENDER = { Interbank: { credit: "tarjetasdecredito@eecc.interbank.pe" }, BCP: { credit: "notificaciones@notificacionesbcp.com.pe", debit: "notificaciones@notificacionesbcp.com.pe" } };
function statementMails(p, from, to) {
  const out = [];
  (p.accounts || []).forEach((a) => {
    const sender = (STATEMENT_SENDER[a.bank] || {})[a.type];
    if (!sender || (a.type === "debit" && !a.code)) return;
    const layout = (a.bank === "BCP" ? "bcp" : "interbank") + (a.type === "credit" ? "Card" : "Savings");
    for (let d = from; d <= to; d = life.addDays(d, 1)) {
      const day = +d.slice(8);
      if ((a.type === "credit" && day !== 28) || (a.type === "debit" && day !== 3)) continue;
      const y = +d.slice(0, 4), mo = +d.slice(5, 7) - (a.type === "debit" ? 1 : 0);
      const st = statement(p, layout, a, y, mo);
      out.push({ from: `${a.bank} <${sender}>`, to: `${p.first} <${p.id}@example.com>`, subject: a.type === "credit" ? "Estado de cuenta de tu tarjeta " + a.last4 : "Tu estado de cuenta de ahorros",
        body: "Adjuntamos tu estado de cuenta. Este es un mensaje automático.", at: d + "T09:00", attachments: [{ name: "estado-de-cuenta-" + a.last4 + ".pdf", bytes: [...st.buf] }] });
    }
  });
  return out;
}

// ---------- start / stop ----------
async function start(p) {
  const dir = dirOf(p), pt = ports(p);
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  const st = readState(p);
  if (st.appPid) throw new Error(p.id + " is already started (stop it first; stopping resets the copy)");
  const log = fs.openSync(path.join(dir, "server.log"), "a");
  const env = { ...process.env, TIME_TRAVEL: "1", CLOCK_START: p.clockStart + "T07:30", EMPTY: "1", FRIEND_COPY: "1", PORT: String(pt.app) };
  const srv = spawn(process.execPath, [path.join(REPO, "tests/harness/server.js")], { env, detached: true, stdio: ["ignore", log, log] });
  srv.unref();
  for (let i = 0; i < 40; i++) { await sleep(300); try { await req(pt.app, "GET", "/__clock"); break; } catch (e) { /* not yet */ } }
  if (p.bots && p.bots.whatsapp) await req(pt.app, "POST", "/__bots", { whatsapp: true });
  if (p.bots && p.bots.telegram) await req(pt.app, "POST", "/__bots", { telegram: true });
  const plog = fs.openSync(path.join(dir, "phone.log"), "a");
  const ph = spawn(process.execPath, [__filename, "__phone", p.id], { env: process.env, detached: true, stdio: ["ignore", plog, plog] });
  ph.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); try { await req(pt.phone, "GET", "/ping"); break; } catch (e) { /* not yet */ } }
  writeState(p, { ...st, appPid: srv.pid, phonePid: ph.pid, started: new RealDate().toISOString(), journeyStart: p.clockStart, livedUntil: life.addDays(p.clockStart, -1), mailsUntil: life.addDays(p.clockStart, -1) });
  const files = makeFiles(p);
  return `Started ${p.id}: app http://localhost:${pt.app} (copy for a brand-new friend, clock ${p.clockStart} 07:30 Lima), phone on ${pt.phone}.` + (files.length ? "\nFiles in files/: " + files.join("; ") : "");
}
// A new phone process on the same browser profile (the app's memory on the phone stays), the copy untouched.
async function restartPhone(p) {
  const st = readState(p), pt = ports(p);
  if (st.phonePid) try { process.kill(-st.phonePid, "SIGKILL"); } catch (e) { /* gone */ }
  await sleep(800);
  const plog = fs.openSync(path.join(dirOf(p), "phone.log"), "a");
  const ph = spawn(process.execPath, [__filename, "__phone", p.id], { env: process.env, detached: true, stdio: ["ignore", plog, plog] });
  ph.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); try { await req(pt.phone, "GET", "/ping"); break; } catch (e) { /* not yet */ } }
  writeState(p, { ...readState(p), phonePid: ph.pid });
  return "Phone restarted for " + p.id + " (same memory; the app reopened on Home or where it starts).";
}
function stop(p) {
  const st = readState(p);
  // Each was started as its own process group (the phone's browser included): end the whole group at once. Playwright catches
  // the gentle stop signal and keeps running, so it is the hard one.
  [st.appPid, st.phonePid].forEach((pid) => { if (pid) try { process.kill(-pid, "SIGKILL"); } catch (e) { try { process.kill(pid, "SIGKILL"); } catch (e2) { /* gone */ } } });
  writeState(p, { ...st, appPid: null, phonePid: null });
  return "Stopped " + p.id + " (the copy's data is gone; the folder stays).";
}

// ---------- the phone (a long-running process) ----------
async function phone(p) {
  const pw = require(PW);
  const dir = dirOf(p), pt = ports(p);
  const { defaultBrowserType, ...iphone } = pw.devices["iPhone 13"];
  const small = p.phone === "se" ? { viewport: { width: 375, height: 667 }, screen: { width: 375, height: 667 } } : {};
  const ctx = await pw.chromium.launchPersistentContext(path.join(dir, "profile"), { headless: true, ...iphone, ...small, locale: p.lang === "es" ? "es-PE" : "en-US", timezoneId: "America/Lima" });
  // A brand-new person's copy runs the newest server: the app's "is my server behind?" question to GitHub is answered "no news"
  // (the fake server has no version stamp, so the real answer would show an update banner no new person sees).
  await ctx.route("https://api.github.com/**", (r) => r.abort());
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("page error: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: net::ERR_FAILED/.test(m.text())) errors.push("console: " + m.text().slice(0, 300)); });   // (the blocked GitHub check)
  page.on("dialog", async (d) => { errors.push("phone dialog [" + d.type() + "]: " + d.message()); await d.accept(); });
  const app = (u) => `http://localhost:${pt.app}${u}`;
  // First start: sign in (/login). A restarted phone keeps its memory (the browser profile) and just opens the app.
  await page.goto(app("/"));
  if (!(await page.evaluate(() => localStorage.getItem("accessCode")))) await page.goto(app("/login"));
  else { const c = await req(pt.app, "GET", "/__clock"); await page.evaluate((ms) => window.__tt && window.__tt.set(ms), c.now); }
  await page.waitForTimeout(3000);
  const ledgerFile = path.join(dir, "ledger.jsonl");
  let shotN = fs.existsSync(path.join(dir, "shots")) ? fs.readdirSync(path.join(dir, "shots")).length : 0;
  let lastSig = "", busy = false, actor = "tester";

  // What teaches on screen right now, where the person is, and the toast.
  const SURFACES = () => {
    const vis = (el) => !!(el && !el.hidden && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none");
    const t = (el) => ((el && el.innerText) || "").replace(/\s+/g, " ").trim();
    const out = [];
    const spot = document.querySelector(".spot-root");
    if (vis(spot)) out.push({ kind: "tutorial", text: t(spot.querySelector(".spot-bubble") || spot).slice(0, 400) });
    document.querySelectorAll(".pop-tip").forEach((b) => { if (vis(b)) out.push({ kind: "bubble", key: b.dataset.tip, text: t(b).slice(0, 400) }); });
    document.querySelectorAll(".tip-invite-label").forEach((l) => { const box = l.parentElement; if (vis(box)) out.push({ kind: "card", key: box.id, text: t(box).slice(0, 400) }); });
    const w = document.getElementById("welcome-overlay");
    if (vis(w) && t(w)) out.push({ kind: w.classList.contains("tour-mode") ? "tour" : "welcome", text: t(w).slice(0, 300) });
    const c = document.getElementById("app-confirm-backdrop");
    if (vis(c)) out.push({ kind: "question", text: t(c).slice(0, 400) });
    const sheets = [...document.querySelectorAll(".currency-modal-backdrop")].filter(vis).map((s) => t(s.querySelector("h2,h3,.currency-modal-title") || s).slice(0, 60));
    const tab = document.querySelector("nav .active, .tab-bar .active, [aria-current='page']");
    const screens = [...document.querySelectorAll("[id^='screen-'], section[id]")].filter((s) => vis(s) && s.getBoundingClientRect().width > 200).map((s) => s.id);
    const toast = document.getElementById("app-toast");
    return { now: Date.now(), surfaces: out, where: { tab: t(tab).slice(0, 30), screens: screens.slice(-2), sheets }, toast: vis(toast) ? t(toast) : "" };
  };
  const state = async () => { try { return await page.evaluate(SURFACES); } catch (e) { return { now: 0, surfaces: [], where: {}, toast: "", err: e.message }; } };
  const lima = (ms) => new RealDate(ms - 5 * 3600000).toISOString().slice(0, 16).replace("T", " ");
  const ledger = (o) => fs.appendFileSync(ledgerFile, JSON.stringify(o) + "\n");

  // The teaching ledger: every teaching surface that appears or goes away, with the phone's (simulated) time and who was acting.
  setInterval(async () => {
    if (busy === "nav") return;
    const s = await state();
    const sig = JSON.stringify(s.surfaces.map((x) => [x.kind, x.key, x.text.slice(0, 80)]));
    if (sig !== lastSig) {
      const before = lastSig ? JSON.parse(lastSig) : [];
      const now = JSON.parse(sig);
      now.filter((x) => !before.some((y) => JSON.stringify(y) === JSON.stringify(x))).forEach((x) => {
        const full = s.surfaces.find((y) => y.kind === x[0] && y.key === x[1]) || {};
        ledger({ at: lima(s.now), event: "shown", kind: x[0], key: x[1], text: full.text, where: s.where, actor });
      });
      before.filter((y) => !now.some((x) => JSON.stringify(x) === JSON.stringify(y))).forEach((y) => ledger({ at: lima(s.now), event: "gone", kind: y[0], key: y[1], actor }));
      lastSig = sig;
    }
    if (s.toast && s.toast !== state.lastToast) ledger({ at: lima(s.now), event: "toast", text: s.toast, actor });
    state.lastToast = s.toast;
  }, 600);

  // Visible text and the things that can be tapped, numbered (data-jn) for "tap 12".
  const LOOK = () => {
    const H = window.innerHeight, W = window.innerWidth;
    const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
    const vis = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05; };
    const lines = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, last = null;
    while ((n = walker.nextNode())) {
      const s = n.textContent.replace(/\s+/g, " ").trim();
      if (!s || !n.parentElement || !vis(n.parentElement) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement.tagName)) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (!inView(r)) continue;
      const top = Math.round(r.top / 6);
      if (last && last.top === top) last.text += " " + s; else { last = { top, text: s }; lines.push(last); }
    }
    document.querySelectorAll("[data-jn]").forEach((e) => e.removeAttribute("data-jn"));
    const cands = [...document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=switch], input, select, textarea, label, summary, [onclick], [tabindex]")]
      .concat([...document.querySelectorAll("li, div, span")].filter((e) => getComputedStyle(e).cursor === "pointer"));
    const seen = new Set(), clickables = [];
    cands.forEach((e) => {
      if (seen.has(e) || !vis(e)) return;
      const r = e.getBoundingClientRect();
      if (!inView(r) || r.width < 8 || r.height < 8) return;
      // keep the innermost of nested clickables with the same text
      const label = (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || "").replace(/\s+/g, " ").trim().slice(0, 70);
      const kind = e.tagName === "INPUT" ? "input:" + (e.type || "text") : e.tagName.toLowerCase();
      if (!label && !/^input|select|textarea/.test(kind)) return;
      seen.add(e);
      clickables.push({ e, label, kind, r });
    });
    // One item per thing: a word inside a tappable row is the row.
    const keep = clickables.filter((c) => !clickables.some((o) => o !== c && o.e.contains(c.e) && o.label.includes(c.label)));
    const out = keep.slice(0, 70).map((c, i) => {
      c.e.setAttribute("data-jn", String(i + 1));
      const lab = c.e.labels && c.e.labels[0] ? c.e.labels[0].innerText.trim().slice(0, 40) : "";
      const val = /^input|select|textarea/.test(c.kind) ? ` = "${String(c.e.value || "").slice(0, 40)}"` + (c.e.checked !== undefined && /checkbox|radio/.test(c.e.type) ? (c.e.checked ? " [on]" : " [off]") : "") : "";
      return `[${i + 1}] ${c.kind} "${c.label || lab}"${val}${c.e.disabled ? " (disabled)" : ""}`;
    });
    const sy = document.scrollingElement ? Math.round(document.scrollingElement.scrollTop) : 0;
    return { text: lines.map((l) => l.text).join("\n").slice(0, 3500), clickables: out, scroll: sy };
  };

  // A real finger tap at the middle of a target (by data-jn number, by visible text, or a point).
  async function locate(target) {
    if (/^\d+$/.test(String(target))) {
      const h = await page.$(`[data-jn="${target}"]`);
      if (!h) throw new Error("No item " + target + " — run look first (numbers change after every look)");
      return h;
    }
    const h = await page.evaluateHandle((txt) => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const want = norm(txt);
      const vis = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
      const all = [...document.querySelectorAll("body *")].filter((e) => vis(e));
      const lab = (e) => norm(e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || "");
      const clickable = (e) => e.matches("button, a, [role=button], [role=tab], input, select, textarea, label, summary") || getComputedStyle(e).cursor === "pointer";
      const score = (e) => { const r = e.getBoundingClientRect(); return (clickable(e) ? 0 : 1e7) + r.width * r.height; };
      let hits = all.filter((e) => lab(e) === want);
      if (!hits.length) hits = all.filter((e) => lab(e).includes(want));
      hits.sort((a, b) => score(a) - score(b));
      return hits[0] || null;
    }, String(target));
    const el = h.asElement();
    if (!el) throw new Error(`Nothing on screen says "${target}"`);
    return el;
  }
  async function tapEl(el) {
    // Like a finger: scroll first when the item is off screen OR covered at its middle (the bottom tab bar, a fixed header).
    await el.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (r.bottom < 0 || r.top > window.innerHeight || !(top && (top === e || e.contains(top) || top.contains(e)))) e.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(250);
    const b = await el.boundingBox();
    if (!b) throw new Error("That item has no size on screen");
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  }
  async function short() {
    await page.waitForTimeout(900);
    const s = await state();
    return [`[${lima(s.now)}] ${JSON.stringify(s.where)}`, ...s.surfaces.map((x) => `TEACHING ${x.kind}${x.key ? " (" + x.key + ")" : ""}: ${x.text}`), s.toast ? "Toast: " + s.toast : "", ...errors.splice(0)].filter(Boolean).join("\n");
  }
  async function look() {
    const s = await state();
    const l = await page.evaluate(LOOK);
    const shot = path.join(dir, "shots", String(++shotN).padStart(4, "0") + "-" + lima(s.now).replace(/[: ]/g, "") + ".png");
    await page.screenshot({ path: shot, scale: "css" });
    return [`[${lima(s.now)}] where: ${JSON.stringify(s.where)} scroll ${l.scroll}`, ...s.surfaces.map((x) => `TEACHING ${x.kind}${x.key ? " (" + x.key + ")" : ""}: ${x.text}`),
      s.toast ? "Toast: " + s.toast : "", ...errors.splice(0), "--- screen text ---", l.text, "--- can tap ---", ...l.clickables, "screenshot: " + shot].filter(Boolean).join("\n");
  }

  // ---------- the routine days ----------
  async function open() {   // the person opens the app (a PWA started fresh)
    busy = "nav";
    const c = await req(pt.app, "GET", "/__clock");
    await page.goto(app("/?cb=" + c.now), { waitUntil: "load" });
    await page.evaluate((ms) => window.__tt && window.__tt.set(ms), c.now);
    busy = false;
    try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch (e) { /* busy app */ }
    await page.waitForTimeout(2500);
  }
  async function moveTo(day, hhmm) {
    const out = await req(pt.app, "POST", "/__clock", { to: day + "T" + hhmm });
    if (out.error) throw new Error(out.error);
    await page.evaluate((ms) => window.__tt && window.__tt.set(ms), out.now).catch(() => {});
    return out;
  }
  async function queueMails(st, until) {
    if (st.mailsUntil >= until) return 0;
    const items = life.days(p, life.addDays(st.mailsUntil, 1), until);
    const mails = life.mails(p, items).concat(statementMails(p, life.addDays(st.mailsUntil, 1), until));
    if (mails.length) await req(pt.app, "POST", "/__bankmail", mails);
    st.mailsUntil = until;
    return mails.length;
  }
  async function saveTyped(t) {
    return page.evaluate(async ({ t, acct }) => {
      const FALLBACK = { going_out: ["restaurants"], subscriptions: ["home"], vehicle: ["transport"], kids: ["other"], health: ["other"], family_support: ["other"], interest: ["bank_fees"], shopping: ["other"], salary: [] };
      const meta = await callApi("getMeta", {});
      const cats = meta.categories.filter((c) => c.type === t.type && !c.hidden);
      const cat = [t.cat].concat(FALLBACK[t.cat] || [], ["other"]).map((k) => cats.find((c) => c.key === k)).find(Boolean);
      const banks = Object.fromEntries((meta.banks || []).map((b) => [b.id, b.name]));
      const pms = (meta.paymentMethods || []).filter((m) => !m.hidden && String(m.archived || "") !== "true");
      let pm = null;
      if (t.via === "cash") pm = pms.find((m) => m.type === "cash");
      else if (acct) pm = pms.find((m) => String(m.last4 || "") === acct.last4) || pms.find((m) => (banks[m.bank_id] || "") === acct.bank && m.type === acct.type);
      const id = crypto.randomUUID();
      const fields = { type: t.type, date: t.date, amount: t.amount, currency: t.currency, category_id: cat ? cat.id : "", description: t.merchant, paid_by: "me", payment_method_id: pm ? pm.id : "" };
      await callApi("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id, tag_ids: [] }) });
      return (cat ? cat.name : "no category") + (pm ? " · " + pm.nickname : "");
    }, { t, acct: (p.accounts || []).find((a) => a.id === t.via) || null });
  }
  async function live(args) {
    const st = readState(p);
    const until = args.until || life.addDays(st.livedUntil, Number(args.days || 1));
    const report = [];
    actor = "robot";
    try {
      const pre = await state();
      if (pre.surfaces.length) return "Something is teaching on screen right now; handle it first:\n" + (await short());
      for (let d = life.addDays(st.livedUntil, 1); d <= until; d = life.addDays(d, 1)) {
        const nMail = await queueMails(st, until);
        if (nMail) report.push(`(${nMail} bank e-mails will arrive over these days)`);
        const items = life.days(p, d, d);
        const day = new RealDate(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
        if (!life.opensApp(p, st.journeyStart, d)) {
          await moveTo(d, "23:30");
          st.livedUntil = d; writeState(p, st);
          report.push(`${day}: did not open the app (${items.length} things happened in life)`);
          continue;
        }
        const typed = items.filter((t) => life.typesIt(p, t));
        const at = p.atNight ? "21:00" : (typed[0] ? typed[0].time : "20:30");
        await moveTo(d, at);
        await open();
        let s = await state();
        if (s.surfaces.length) { report.push(`${day} ${at}: opened the app — STOPPED, the app is teaching:`); st.livedUntil = life.addDays(d, -1); writeState(p, st); report.push(await short()); return report.join("\n"); }
        const done = [];
        for (const t of typed) {
          if (!p.atNight && t.time > at) await moveTo(d, t.time);
          const where = await saveTyped(t);
          done.push(`${t.type === "income" ? "+" : ""}${t.currency} ${t.amount} ${t.merchant} → ${where}`);
          await page.waitForTimeout(1200);
          s = await state();
          if (s.surfaces.length) {
            st.livedUntil = d; writeState(p, st);
            report.push(`${day}: typed ${done.join("; ")} — STOPPED, the app is teaching:`, await short());
            return report.join("\n");
          }
        }
        const pend = await page.evaluate(async () => { try { return (await callApi("getStartupBundle", { entriesLimit: 1 })).pending.length; } catch (e) { return "?"; } });
        report.push(`${day}: opened at ${at}; typed ${done.length ? done.join("; ") : "nothing"}; Needs review: ${pend} waiting`);
        // Something new a person would notice on Home hands over to the tester: the first time items wait in Needs review.
        if (pend > 0 && !st.sawPending) {
          st.sawPending = true; st.livedUntil = d; writeState(p, st);
          report.push(`STOPPED: for the first time, ${pend} item(s) wait in Needs review on Home (the app is open on ${d} ${at}). The tester decides what ${p.first} does.`);
          return report.join("\n");
        }
        await moveTo(d, "23:30");
        st.livedUntil = d; writeState(p, st);
      }
      report.push(`Reached ${until}. Next: the tester's session (the phone is on the last day, the app closed at night; "reload" opens it).`);
      return report.join("\n");
    } finally { actor = "tester"; }
  }

  // ---------- commands ----------
  const COMMANDS = {
    look, ping: async () => "ok",
    tap: async (a) => {
      if (a[0] === "--at") { const [x, y] = a[1].split(",").map(Number); await page.touchscreen.tap(x, y); return short(); }
      await tapEl(await locate(a.join(" "))); return short();
    },
    fill: async (a) => {
      // A label (or a row holding the box) leads to its box.
      let el = await locate(a[0]);
      const box = await el.evaluateHandle((e) => (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) ? e : (e.control || e.querySelector("input, textarea") || (e.htmlFor && document.getElementById(e.htmlFor)) || e)));
      el = box.asElement() || el;
      // A list (select): pick the option whose words match, as the phone's wheel would.
      if (await el.evaluate((e) => e.tagName === "SELECT")) {
        const want = a.slice(1).join(" ").toLowerCase();
        const val = await el.evaluate((e, w) => { const o = [...e.options].find((x) => x.text.toLowerCase() === w) || [...e.options].find((x) => x.text.toLowerCase().includes(w)); return o ? o.value : null; }, want);
        if (val === null) throw new Error("No option like \"" + want + "\" in that list (look shows its options)");
        await el.selectOption(val);
        return short();
      }
      await tapEl(el); await el.evaluate((e) => { if (e.select) e.select(); }); await page.keyboard.press("Backspace"); await page.keyboard.type(a.slice(1).join(" "), { delay: 25 }); return short(); },
    type: async (a) => { await page.keyboard.type(a.join(" "), { delay: 25 }); return short(); },
    key: async (a) => { await page.keyboard.press(a[0]); return short(); },
    scroll: async (a) => { const dy = (a[0] === "up" ? -1 : 1) * Number(a[1] || 500); const v = page.viewportSize(); await page.mouse.move(v.width / 2, v.height / 2); await page.mouse.wheel(0, dy); return short(); },
    wait: async (a) => { await page.waitForTimeout(Number(a[0] || 1) * 1000); return short(); },
    reload: async () => { await open(); return short(); },
    back: async () => { await page.goBack().catch(() => {}); return short(); },
    upload: async (a) => {
      const file = path.isAbsolute(a[0]) ? a[0] : path.join(dir, "files", a[0]);
      if (!fs.existsSync(file)) throw new Error("No file " + file);
      const el = await locate(a.slice(1).join(" "));
      // The button's own file box (a label's control, or one inside it) gets the file as the phone's picker would give it;
      // otherwise tap and wait for a picker.
      const input = (await el.evaluateHandle((e) => (e.matches("input[type=file]") ? e : e.control && e.control.type === "file" ? e.control : e.querySelector("input[type=file]") || (e.closest("label") && e.closest("label").control) || null))).asElement();
      if (input) await input.setInputFiles(file);
      else {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), tapEl(el)]);
        await chooser.setFiles(file);
      }
      await page.waitForTimeout(2500);
      return short();
    },
    live: async (a) => { const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, "")] = a[i + 1]; return live(o); },
    eval: async (a) => JSON.stringify(await page.evaluate(a.join(" "))),
    // What the phone remembers about teaching (what was taught and how, tips seen, bubbles and their use, today's budget).
    memory: async () => JSON.stringify(await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/tip|tutorial|pop|teach|tour|practice|nudge|idle|guided|seen/i.test(k)) { const v = localStorage.getItem(k); try { o[k] = JSON.parse(v); } catch (e) { o[k] = v; } }
      }
      return o;
    }), null, 1),
  };
  http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", async () => {
      const url = rq.url;
      if (url === "/ping") { rs.end(JSON.stringify("ok")); return; }
      const { cmd, args } = JSON.parse(body || "{}");
      let out;
      try {
        if (!COMMANDS[cmd]) throw new Error("Unknown command " + cmd);
        out = await COMMANDS[cmd](args || []);
      } catch (e) { out = "ERROR: " + e.message + "\n" + (await short().catch(() => "")); }
      rs.end(JSON.stringify(out));
    });
  }).listen(pt.phone, "127.0.0.1");
}

// ---------- the brief a tester agent gets ----------
function brief(p) {
  const pt = ports(p), st = readState(p);
  const bring = p.bring ? (p.bring.kind === "statements" ? "last month's bank statements/movements" : "an export of " + p.bring.kind) : "nothing (blank start)";
  return [`${p.first} (${p.lang === "es" ? "uses the app in Spanish" : "uses the app in English"}${p.phone === "se" ? ", small iPhone" : ""}). Situation: ${p.situation}`,
    `This run: starts with ZERO use of the app on ${p.clockStart}, for ${p.months} months. Brings ${bring}. ${p.journey}`,
    `Accounts in real life: ${(p.accounts || []).map((a) => `${a.bank} ${a.type} …${a.last4}${a.mail ? " (bank e-mails)" : ""}`).join(", ") || "none"}.`,
    `Copy: http://localhost:${pt.app} · folder ${dirOf(p)} · lived until ${st.livedUntil || "-"}`].join("\n");
}

// ---------- main ----------
(async () => {
  const [a0, a1, ...rest] = process.argv.slice(2);
  try {
    if (a0 === "__phone") { await phone(persona(a1)); return; }
    if (a0 === "start") { console.log(await start(persona(a1))); return; }
    if (a0 === "list") { console.log(PERSONAS.map((p) => `${p.id.padEnd(8)} ${p.start.padEnd(10)} ${p.clockStart} ${p.months} months  ports ${ports(p).app}/${ports(p).phone}`).join("\n")); return; }
    const p = persona(a0);
    const pt = ports(p);
    if (a1 === "stop") { console.log(stop(p)); return; }
    if (a1 === "phone-restart") { console.log(await restartPhone(p)); return; }
    if (a1 === "brief") { console.log(brief(p)); return; }
    if (a1 === "files") { console.log(makeFiles(p).join("\n")); return; }
    if (a1 === "note") { fs.appendFileSync(path.join(dirOf(p), "journal.md"), `\n- [${(await req(pt.app, "GET", "/__clock")).lima}] ${rest.join(" ")}`); console.log("noted"); return; }
    if (a1 === "clock") { console.log(JSON.stringify(await req(pt.app, "GET", "/__clock"))); return; }
    if (a1 === "ledger") { const f = path.join(dirOf(p), "ledger.jsonl"); console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return `${o.at} ${o.actor || ""} ${o.event} ${o.kind || ""}${o.key ? "(" + o.key + ")" : ""} ${o.text ? o.text.slice(0, 140) : ""}`; }).join("\n") : "(empty)"); return; }
    if (a1 === "chat" || a1 === "chat-tap") {
      const body = a1 === "chat" ? { bot: rest[0], text: rest.slice(1).join(" ") } : { bot: rest[0], tap: rest.slice(1).join(" ") };
      const out = await req(pt.app, "POST", "/__chat", body);
      console.log(Array.isArray(out) ? out.map((c) => `${c.when} ${c.who === "me" ? "ME " : "BOT"}: ${c.text}${c.buttons && c.buttons.length ? "  [buttons: " + c.buttons.map((b) => b.title).join(" | ") + "]" : ""}`).join("\n") : JSON.stringify(out));
      return;
    }
    if (a1 === "chatlog") { const out = await req(pt.app, "GET", "/__chat"); console.log(out.map((c) => `${c.when} ${c.bot} ${c.who === "me" ? "ME " : "BOT"}: ${c.text}${c.buttons && c.buttons.length ? "  [buttons: " + c.buttons.map((b) => b.title).join(" | ") + "]" : ""}`).join("\n") || "(no messages)"); return; }
    const out = await req(pt.phone, "POST", "/cmd", { cmd: a1, args: rest });
    console.log(out);
  } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
})();
