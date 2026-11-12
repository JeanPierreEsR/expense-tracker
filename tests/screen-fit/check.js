// Screen-fit check: opens the real app on the test server at the width of a small iPhone (375 px: SE 2nd/3rd gen,
// 12/13 mini), in English and in Spanish, and lists anything that runs off the right edge or whose text is cut
// short. ship.sh runs it before publishing an app change and stops on a finding (owner's rule, 2026-11-07).
// It only MEASURES: a screen that fits but looks crowded is left to the testers.
//   node tests/screen-fit/check.js            (needs Playwright: see tests/README.md § Screen-fit check)
//   WIDTH=320 node tests/screen-fit/check.js  (another width, for a look by hand; ship.sh uses 375)
// Made-up data only (the test server's demo copy).
const path = require("path");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const TOOLS = process.env.SCREEN_FIT_DIR || path.join(os.homedir(), ".expense-tracker-tools");
let chromium;
try { ({ chromium } = require(require.resolve("playwright", { paths: [__dirname, TOOLS] }))); }
catch (e) { console.error(`NO-PLAYWRIGHT: install it once with  npm install --prefix "${TOOLS}" playwright@1.65.0`); process.exit(3); }

const WIDTH = Number(process.env.WIDTH || 375);
const HEIGHT = 667;
// The More sub-screens, opened through their real rows (a row that is hidden on this copy is skipped).
const MORE_ROWS = ["more-recurring-btn", "more-trips-btn", "more-accounts-btn", "more-bank-mail-btn", "more-categories-btn",
  "more-exchange-rates-btn", "more-friends-btn", "more-my-data-btn", "more-my-profile-btn", "more-perf-btn", "more-feedback-privacy-btn"];
const MY_DATA_ROWS = ["data-statements-btn", "data-import-btn", "data-tidy-btn", "more-deleted-btn", "data-export-btn"];
const TABS = ["entries", "overview", "budgets", "projections", "loans", "more"];

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page: what does not fit on the screen showing now.
function audit() {
  const W = document.documentElement.clientWidth;
  const out = [];
  const name = (el) => (el.id ? "#" + el.id : el.classList.length ? "." + [...el.classList].join(".") : el.tagName.toLowerCase());
  const where = (el) => { const parts = []; let p = el; for (let i = 0; p && p !== document.body && i < 3; i++, p = p.parentElement) parts.unshift(name(p)); return parts.join(" > "); };
  const text = (el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (document.documentElement.scrollWidth > W + 1) out.push(`the whole page scrolls sideways by ${document.documentElement.scrollWidth - W}px`);
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.position === "fixed" && (r.left >= W || r.right <= 0)) continue;
    // An ancestor that scrolls or clips sideways makes this element's position its own business (a swipeable row).
    let held = false;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== "visible") { held = true; break; }
    }
    if (!held && (r.right > W + 1 || r.left < -1)) out.push(`runs off the screen (${Math.round(r.left)}–${Math.round(r.right)}px of ${W}): ${where(el)} "${text(el)}"`);
    // Text cut by its own box. A name shortened with "…" is a deliberate cut; a number never is (it would read as a wrong amount).
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText && el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(st.overflowX) && (st.textOverflow !== "ellipsis" || /\d/.test(el.textContent)))
      out.push(`${st.textOverflow === "ellipsis" ? "number cut with …" : "text is cut"}: ${where(el)} "${text(el)}"`);
  }
  return [...new Set(out)];
}

(async () => {
  const root = path.join(__dirname, "..", "..");
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, "tests", "harness", "server.js")], { env: { ...process.env, PORT: String(port), SLOW: "" }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) { try { await fetch(base + "/login", { redirect: "manual" }); break; } catch (e) { await sleep(200); } }
  const browser = await chromium.launch();
  const findings = [];
  let looked = 0;
  try {
    for (const lang of ["en", "es"]) {
      await fetch(base + "/__reset", { method: "POST" });
      const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, screen: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: lang === "es" ? "es-PE" : "en-US" });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => d.accept());
      await page.goto(base + "/login");
      await page.waitForFunction(() => window.I18n && document.querySelector(".nav-btn"), null, { timeout: 20000 });
      await page.evaluate((l) => I18n.saveLang(l), lang);
      await page.reload();
      await page.waitForFunction(() => window.I18n && document.querySelector(".nav-btn"), null, { timeout: 20000 });
      await sleep(1500);
      // Wait until the screen showing has stopped saying "Loading…" (at most 8 s), then a moment for the last drawing.
      const settle = async () => {
        await page.waitForFunction(() => {
          const scr = [...document.querySelectorAll(".screen")].find((s) => !s.hidden);
          if (!scr) return true;
          const busy = tr("common.loading");
          return ![...scr.querySelectorAll("*")].some((e) => e.children.length === 0 && e.offsetParent && e.textContent.trim() === busy);
        }, null, { timeout: 8000 }).catch(() => {});
        await sleep(400);
      };
      const look = async (label) => {
        await settle();
        // The demo's "Pause has been replaced" sheet (a forced choice) is not part of any screen.
        await page.evaluate(() => document.querySelectorAll("[data-no-dismiss]").forEach((b) => { b.hidden = true; }));
        if (process.env.SCREEN_FIT_SELFTEST) await page.evaluate(() => { const scr = [...document.querySelectorAll(".screen")].find((x) => !x.hidden); const d = document.createElement("div"); d.style.width = "120vw"; d.textContent = "self-test box"; scr && scr.appendChild(d); });
        looked++;
        for (const f of await page.evaluate(audit)) findings.push(`[${lang}] ${label}: ${f}`);
      };
      for (const tab of TABS) {
        await page.evaluate((t) => document.querySelector(`.nav-btn[data-screen="${t}"]`).click(), tab);
        await look(tab === "entries" ? "Home" : tab);
      }
      // The new-entry sheet.
      await page.evaluate(() => document.querySelector('.nav-btn[data-screen="entries"]').click());
      await settle();
      if (await page.evaluate(() => { const b = document.getElementById("fab-new-entry"); if (!b || b.hidden) return false; b.click(); return true; })) {
        await look("new entry");
        await page.evaluate(() => { const x = [...document.querySelectorAll(".currency-modal-backdrop")].find((b) => !b.hidden); x && x.querySelector(".currency-modal-close")?.click(); });
        await sleep(300);
      }
      const openRow = async (id) => page.evaluate((i) => { const b = document.getElementById(i); if (!b || b.hidden || !b.offsetParent) return null; b.click(); return (b.textContent || i).trim().replace(/\s+/g, " ").slice(0, 30); }, id);
      for (const id of MORE_ROWS) {
        await page.evaluate(() => showScreen("more"));
        await sleep(200);
        const label = await openRow(id);
        if (!label) continue;
        await look("More → " + label);
        if (id === "more-my-data-btn") {
          for (const sub of MY_DATA_ROWS) {
            await page.evaluate(() => showScreen("my-data"));
            await sleep(200);
            const l2 = await openRow(sub);
            if (l2) await look("More → My data → " + l2);
          }
        }
      }
      // Every Edit-mode bar (the fixed bar of Select all / Done / Delete …), with EVERY label each button can show and big
      // counts, in every combination: no two buttons may overlap, run off the bar, cut their text or be under 44 px tall
      // (owner, 2026-11-12: "Select all 33 matches" was printed on top of "Done"). A new label for a bar button goes in SLOTS.
      for (const f of await page.evaluate(() => {
        const out = [];
        const n = 999, big = 99999;
        const SLOTS = {
          selectall: [tr("friends.selectAll"), tr("friends.selectNone")],
          done: [tr("friends.done")],
          del: [tr("friends.deletePick"), tr("friends.deleteN", { n })],
          change: [tr("entriesBulk.change"), tr("entriesBulk.changeN", { n })],
          confirm: [tr("review.confirm"), tr("reviewBulk.confirmN", { n })],
          discard: [tr("review.discard"), tr("reviewBulk.discardN", { n })],
        };
        // Labels only some bars show (app.js: syncEntriesEditBar_, syncBudgetsEditBar_, syncOneKindBar_).
        const EXTRA = {
          "entries-selectall-btn": [tr("entriesBulk.selectAllMatches", { n: big })],
          "budgets-delete-selected-btn": [tr("budgets.endPick"), tr("budgets.endN", { n })],
          "accounts-delete-selected-btn": [tr("bulkShow.showN", { n })],
          "categories-delete-selected-btn": [tr("bulkShow.showN", { n })],
          "friends-delete-selected-btn": [tr("bulkShow.showN", { n })],
        };
        const slotOf = (b) => /selectall/.test(b.id) ? "selectall" : /done/.test(b.id) ? "done" : /change/.test(b.id) ? "change"
          : /confirm/.test(b.id) ? "confirm" : /discard/.test(b.id) ? "discard" : "del";
        const bars = [...document.querySelectorAll(".friends-editbar")];
        if (!bars.length) out.push("no Edit-mode bars found");
        for (const bar of bars) {
          document.body.appendChild(bar);   // out of its (hidden) screen, so it lays out as it does on the phone
          bar.hidden = false;
          const all = [...bar.querySelectorAll("button")];
          // Home's "Change" button only shows with the right backend: try the bar both with and without it.
          const variants = all.some((b) => slotOf(b) === "change") ? [all, all.filter((b) => slotOf(b) !== "change")] : [all];
          for (const btns of variants) {
            all.forEach((b) => { b.hidden = !btns.includes(b); });
            let combos = [[]];
            for (const b of btns) combos = combos.flatMap((c) => SLOTS[slotOf(b)].concat(EXTRA[b.id] || []).map((t) => c.concat(t)));
            for (const combo of combos) {
              btns.forEach((b, i) => { b.textContent = combo[i]; });
              const br = bar.getBoundingClientRect();
              const rs = btns.map((b) => b.getBoundingClientRect());
              const where = `${bar.id} [${combo.join(" | ")}]`;
              btns.forEach((b, i) => {
                const r = rs[i];
                if (r.left < br.left - 0.5 || r.right > br.right + 0.5 || r.right > window.innerWidth + 0.5) out.push(`${where}: "${combo[i]}" runs off the bar`);
                if (b.scrollWidth > b.clientWidth + 1) out.push(`${where}: "${combo[i]}" is cut by its button`);
                if (r.height < 43.5) out.push(`${where}: "${combo[i]}" is only ${Math.round(r.height)} px tall`);
                for (let j = i + 1; j < btns.length; j++) {
                  const s = rs[j];
                  if (r.left < s.right - 0.5 && s.left < r.right - 0.5 && r.top < s.bottom - 0.5 && s.top < r.bottom - 0.5) out.push(`${where}: "${combo[i]}" overlaps "${combo[j]}"`);
                }
              });
            }
          }
          bar.hidden = true;
        }
        return [...new Set(out)];
      })) findings.push(`[${lang}] Edit bar ${f}`);
      looked++;
      for (const e of errors) findings.push(`[${lang}] page error: ${e}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (findings.length) {
    console.log(`Screen-fit check at ${WIDTH}px: ${findings.length} problem(s) on ${looked} screens:`);
    for (const f of findings) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log(`Screen-fit check at ${WIDTH}px: ${looked} screens, English and Spanish — everything fits.`);
})().catch((e) => { console.error("Screen-fit check could not run: " + e.message); process.exit(2); });
