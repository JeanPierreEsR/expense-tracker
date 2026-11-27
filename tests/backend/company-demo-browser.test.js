// The company test copy in a real browser (plan "Empresa de prueba en el teléfono", 2026-11-27): it opens from the owner's copy,
// saves inside the phone, and NOTHING reaches the real copy's server; on Exit the real copy's sign-in comes back as it was.
// Needs the same Playwright as the screen-fit check (~/.expense-tracker-tools); skipped where it is not installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");

let chromium = null;
try { ({ chromium } = require(require.resolve("playwright", { paths: [__dirname, process.env.SCREEN_FIT_DIR || path.join(os.homedir(), ".expense-tracker-tools")] }))); }
catch (e) { /* not installed here */ }

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => ok(p)); }); });
const signIn = ["apiUrl", "accessCode", "sessionToken"];

test("the test copy never reaches the real server, and Exit gives the real copy back", { skip: !chromium && "Playwright not installed", timeout: 240000 }, async () => {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(__dirname, "..", "harness", "server.js")], { env: { ...process.env, PORT: String(port), SLOW: "" }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 100; i++) { try { await fetch(base + "/login"); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const calls = [];
    page.on("request", (r) => calls.push(r.url()));
    // Closes the one-time questions; the app then ignores taps for 0.4 s (its double-tap shield), so wait a little more than that.
    const clear = async () => { for (const id of ["#payor-merge-save", "#perf-share-no"]) if (await page.isVisible(id)) { await page.click(id); await page.waitForTimeout(800); } };
    // Taps a More row until its screen shows (a tap can land inside the shield, or before a late question pops up).
    const openMore = async () => {
      for (let i = 0; i < 20 && !(await page.isVisible("#screen-more")); i++) { await clear(); await page.click('.nav-btn[data-screen="more"]'); await page.waitForTimeout(600); }
    };
    await page.goto(base + "/login");
    await page.waitForFunction(() => typeof meta !== "undefined" && meta && meta.capabilities, null, { timeout: 60000 });
    await page.evaluate(() => localStorage.setItem("etOnboarded", "1"));
    const before = await page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)), signIn);
    // More → Companies & projects, tapped again until its screen shows: the pack is switched on for the owner's copy just after the first
    // load (enableBusinessForOwnerOnce), and a late refresh or question can take the screen back.
    for (let i = 0; i < 60 && !(await page.isVisible("#business-demo-open")); i++) {
      await openMore();
      if (await page.isVisible("#more-business-btn")) await page.click("#more-business-btn", { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(600);
    await Promise.all([page.waitForNavigation(), page.click("#business-demo-open")]);
    calls.length = 0;   // from here on: the test copy

    await page.waitForFunction(() => typeof meta !== "undefined" && meta && meta.capabilities && meta.capabilities.companyCopy === true, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains("company-demo")), true);
    const saved = await page.evaluate(async () => {
      const cat = meta.categories.find((c) => c.type === "expense");
      const out = await callApi("createEntry", { type: "expense", date: new Date().toISOString().slice(0, 10), amount: 12.34, currency: "PEN", category_id: cat.id, description: "Solo en la prueba", paid_by: "me" });
      return !!out;
    });
    assert.ok(saved, "the save worked inside the phone");
    await page.waitForTimeout(1500);   // anything sent after a save (reports, alerts) has had its chance
    const out = calls.filter((u) => /\/api\b|script\.google|googleapis|workers\.dev/.test(u));
    assert.deepEqual(out, [], "no request left the phone for a server");

    for (let i = 0; i < 30 && !(await page.isVisible("#more-demo-exit")); i++) { await openMore(); await page.waitForTimeout(600); }
    await page.waitForTimeout(600);
    await Promise.all([page.waitForNavigation(), page.click("#more-demo-exit")]);
    const after = await page.evaluate((keys) => keys.map((k) => localStorage.getItem(k)), signIn);
    assert.deepEqual(after, before, "the real copy's sign-in is back as it was");
    assert.equal(await page.evaluate(() => localStorage.getItem("etCompanyDemo")), null);
    await page.waitForFunction(() => typeof meta !== "undefined" && meta && meta.capabilities, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => !!meta.capabilities.companyCopy), false, "back on the owner's own copy");
    assert.deepEqual(errors, []);
  } catch (e) {
    if (process.env.DEMO_DEBUG) { const pg = browser.contexts()[0] && browser.contexts()[0].pages()[0]; if (pg) await pg.screenshot({ path: "/tmp/demo-fail.png" }); }
    throw e;
  } finally {
    await browser.close();
    server.kill();
  }
});
