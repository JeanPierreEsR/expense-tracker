// Setup-step and error counts from friends' phones and the installer page (backend/BetaEvents.gs). Made-up ids and names only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const INSTALL_A = "0f8c1c5e-1111-4a2b-9c3d-aaaaaaaaaaaa";
const INSTALL_B = "0f8c1c5e-2222-4a2b-9c3d-bbbbbbbbbbbb";

const setup = (s, name = "tapped", extra = {}) => ({ s, t: Date.now() - 1000, k: "setup", n: name, d: "", v: 12, ...extra });
const err = (s, extra = {}) => ({ s, t: Date.now() - 1000, k: "error", n: "listEntries", d: "network", v: 1, ...extra });
const report = (rt, payload) => post(rt, { action: "reportBeta", payload: { install: INSTALL_A, label: "Ana", app: "2026-10-20T23:44:18Z", device: "iPhone (home screen)", ...payload } });
const stored = (rt) => rt.rows("Beta Events");

test("a setup step needs no sign-in and is appended to the Beta Events tab, in English", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { app: "setup", device: "iPhone", entries: [setup(1, "tapped", { v: 0 }), setup(2, "sheet_created", { v: 14 }), setup(3, "step_failed", { d: "approve", v: 80 })] });
  assert.equal(res.ok, true);
  assert.deepEqual([res.data.ack, res.data.stored], [3, 3]);
  const rows = stored(rt);
  assert.deepEqual(rows.map((r) => r.name), ["tapped", "sheet_created", "step_failed"]);
  assert.deepEqual(rows.map((r) => r.kind), ["setup", "setup", "setup"]);
  assert.equal(rows[2].detail, "approve");
  assert.equal(Number(rows[1].n), 14);
  assert.equal(rows[0].install_id, INSTALL_A);
  assert.equal(rows[0].label, "Ana");
  assert.equal(rows[0].app_version, "setup");
  assert.equal(rows[0].device, "iPhone");
  assert.match(String(rows[0].at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("a failed action is stored with its name and a short code only", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [err(1), err(2, { n: "createEntry", d: "invalid_access_code" })] });
  const rows = stored(rt);
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.detail]), [["error", "listEntries", "network"], ["error", "createEntry", "invalid_access_code"]]);
});

test("sending the same report again adds nothing, and an overlapping one adds only the new entries", () => {
  const { rt } = freshApp({ small: true });
  const batch = [setup(1), setup(2, "sheet_created"), setup(3, "app_created")];
  report(rt, { entries: batch });
  const again = report(rt, { entries: batch });
  assert.deepEqual([again.data.ack, again.data.stored], [3, 0]);
  const more = report(rt, { entries: [batch[2], setup(4, "sent_to_google")] });
  assert.deepEqual([more.data.ack, more.data.stored], [4, 1]);
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [1, 2, 3, 4]);
});

test("each install has its own numbering", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [setup(1), setup(2, "ready")] });
  report(rt, { install: INSTALL_B, label: "Luis", entries: [setup(1), setup(2, "ready")] });
  assert.deepEqual(stored(rt).map((r) => r.label), ["Ana", "Ana", "Luis", "Luis"]);
});

test("only the fixed fields are kept; anything else a report carries never reaches the sheet", () => {
  const { rt } = freshApp({ small: true });
  report(rt, {
    secret: "SENTINEL-top", accessCode: rt.ACCESS_CODE,
    entries: [setup(1, "tapped", { amount: "SENTINEL-amount", email: "SENTINEL@example.com", message: "SENTINEL-msg" })]
  });
  const all = JSON.stringify([...stored(rt)]);
  assert.ok(!all.includes("SENTINEL"));
  assert.ok(!all.includes(rt.ACCESS_CODE));
});

test("malformed entries are dropped but acknowledged, so a phone never keeps resending them", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { entries: [
    setup(1),
    setup(2, "not_a_step"),                          // a setup step that is not on the list
    setup(3, "tapped", { d: "has spaces and = signs" }),
    setup(4, "tapped", { v: -3 }),
    err(5, { n: "=HYPERLINK(1)" }),                  // an action name that could be read as a formula
    err(6, { d: "" }),                               // an error without a code
    err(7, { d: "Some message with the amount 45.20" }),   // a message is not a code
    { s: 8, t: Date.now(), k: "other", n: "tapped", d: "", v: 1 },
    { s: 9, t: 5, k: "setup", n: "tapped", d: "", v: 1 },  // a date from 1970
    "junk", null,
    setup(10, "ready")
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [1, 10]);
  assert.equal(res.data.ack, 10);
});

test("a name typed as a spreadsheet formula is cleaned; a very long one is cut", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { label: "=HYPERLINK(\"http://x\",\"hi\")", entries: [setup(1)] });
  report(rt, { install: INSTALL_B, label: "x".repeat(200), entries: [setup(1)] });
  const labels = stored(rt).map((r) => r.label);
  assert.equal(labels[0], "HYPERLINKhttpxhi");
  assert.equal(labels[1].length, 30);
});

test("an unknown phone type or odd app version is replaced by a safe value", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { device: "=cmd|' /C calc'!A0", app: "<script>", entries: [setup(1)] });
  const r = stored(rt)[0];
  assert.equal(r.device, "Other");
  assert.equal(r.app_version, "");
});

test("an install id that is not a random id is refused and creates nothing", () => {
  const { rt } = freshApp({ small: true });
  for (const bad of ["", "short", "../../etc", "=1+1", "x".repeat(60)]) assert.equal(report(rt, { install: bad, entries: [setup(1)] }).ok, false, bad);
  assert.equal(rt.run("!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Beta Events')"), false);
});

test("at most 100 entries are taken per request, and the acknowledgement stops there", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { entries: Array.from({ length: 130 }, (_, i) => err(i + 1)) });
  assert.deepEqual([res.data.ack, res.data.stored], [100, 100]);
  const next = report(rt, { entries: Array.from({ length: 30 }, (_, i) => err(i + 101)) });
  assert.deepEqual([next.data.ack, next.data.stored], [130, 30]);
});

test("one phone cannot add more than 600 entries in a day (nothing is lost, it is told to try later)", () => {
  const { rt } = freshApp({ small: true });
  let seq = 0;
  for (let i = 0; i < 6; i++) report(rt, { entries: Array.from({ length: 100 }, () => err(++seq)) });
  assert.equal(stored(rt).length, 600);
  const over = report(rt, { entries: [err(++seq)] });
  assert.equal(over.ok, false);
  assert.equal(over.code, "beta_busy");
  assert.equal(stored(rt).length, 600);
});

test("a friend's own copy refuses these reports (only the owner's copy collects them)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "gmail,keepawake");
  const res = report(rt, { entries: [setup(1)] });
  assert.equal(res.ok, false);
  assert.equal(res.code, "beta_not_collected");
});

test("reports never need, accept or count as a wrong access code", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 15; i++) assert.equal(report(rt, { entries: [setup(i + 1)] }).ok, true);
  assert.equal(post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }).ok, true);
});

test("the Beta Events tab is created once, with English headers; speed reports and beta counts do not mix", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [setup(1)] });
  report(rt, { entries: [setup(2, "ready")] });
  post(rt, { action: "reportPerf", payload: { install: INSTALL_A, label: "Ana", app: "x", device: "iPhone", entries: [{ s: 1, t: Date.now() - 1000, k: "call", n: "listEntries", tm: 800, sm: 300, c: false, a: 1, o: true }] } });
  const sheets = rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); })");
  assert.equal(sheets.filter((n) => n === "Beta Events").length, 1);
  assert.deepEqual(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Beta Events').getRange(1,1,1,11).getValues()[0]"),
    ["received_at", "install_id", "label", "seq", "at", "kind", "name", "detail", "n", "app_version", "device"]);
  assert.equal(stored(rt).length, 2);
  assert.equal(rt.rows("Perf Reports").length, 1, "the speed report went to its own tab, with its own numbering");
});

test("near the row limit the owner gets one Telegram heads-up; at the limit reports are refused, never silently dropped", () => {
  const { rt } = freshApp({ small: true });
  require("./helpers").linkTelegram(rt);
  rt.run("BETA_MAX_ROWS_ = 20");
  const said = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).filter((p) => p.includes("Beta Events"));
  report(rt, { entries: Array.from({ length: 15 }, (_, i) => err(i + 1)) });
  assert.equal(said().length, 0);
  report(rt, { entries: [err(16)] });
  assert.equal(said().length, 1, "one heads-up at 80%");
  report(rt, { entries: [err(17)] });
  assert.equal(said().length, 1, "and not again");
  const full = report(rt, { entries: Array.from({ length: 10 }, (_, i) => err(i + 18)) });
  assert.equal(full.ok, false);
  assert.equal(full.code, "beta_full");
  assert.equal(stored(rt).length, 17);
  rt.run("BETA_MAX_ROWS_ = 100000");
  const later = report(rt, { entries: Array.from({ length: 10 }, (_, i) => err(i + 18)) });
  assert.deepEqual([later.ok, later.data.ack, later.data.stored], [true, 27, 10]);
});

// ---- review-queue results ("queue", "queue_edit") and weekly screen counts ("screen") ----

const queue = (s, name = "confirmed", d = "bcp", extra = {}) => ({ s, t: Date.now() - 1000, k: "queue", n: name, d, v: 1, ...extra });
const edit = (s, name = "category", d = "bcp", extra = {}) => ({ s, t: Date.now() - 1000, k: "queue_edit", n: name, d, v: 1, ...extra });
const screen = (s, name = "overview", d = "w2026_43", v = 12, extra = {}) => ({ s, t: Date.now() - 1000, k: "screen", n: name, d, v, ...extra });

test("what the person did with a pending entry is stored with the bank it came from", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [queue(1, "edited", "interbank"), edit(2, "category", "interbank"), edit(3, "amount", "interbank"), queue(4, "discarded", "yape"), queue(5, "confirmed", "no_account")] });
  assert.deepEqual(stored(rt).map((r) => [r.kind, r.name, r.detail]), [
    ["queue", "edited", "interbank"], ["queue_edit", "category", "interbank"], ["queue_edit", "amount", "interbank"],
    ["queue", "discarded", "yape"], ["queue", "confirmed", "no_account"]
  ]);
});

test("a bank the person typed in themselves is stored as other_bank, never by name", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [queue(1, "confirmed", "tia_rosa_savings"), queue(2, "confirmed", "caja_piura"), queue(3, "confirmed", "photo")] });
  assert.deepEqual(stored(rt).map((r) => r.detail), ["other_bank", "caja_piura", "photo"]);
});

test("a queue entry with an unknown outcome or field is dropped", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [queue(1, "deleted"), edit(2, "payee"), edit(3, "category", "bcp", { n: "notes" }), queue(4, "confirmed"), edit(5, "category_filled")] });
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [4, 5]);
});

test("a screen count carries the screen, the week and how many times it was opened", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [screen(1, "overview", "w2026_43", 12), screen(2, "trip_detail", "w2026_43", 3)] });
  assert.deepEqual(stored(rt).map((r) => [r.kind, r.name, r.detail, Number(r.n)]), [["screen", "overview", "w2026_43", 12], ["screen", "trip_detail", "w2026_43", 3]]);
});

test("a screen count with an unknown screen, a bad week or no opens is dropped", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [screen(1, "secret_screen"), screen(2, "overview", "2026-43"), screen(3, "overview", "w2026_43", 0), screen(4, "overview", "w2026_43", 5, { d: "w26_4" }), screen(5, "more", "w2026_44", 2)] });
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [5]);
});

test("every screen of the app is on the list the backend accepts", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  const ids = [...html.matchAll(/id="screen-([a-z-]+)" class="screen/g)].map((m) => m[1].replace(/-/g, "_"));
  assert.ok(ids.length >= 15, "found the screens");
  const { rt } = freshApp({ small: true });
  report(rt, { entries: ids.map((id, i) => screen(i + 1, id)) });
  assert.deepEqual(stored(rt).map((r) => r.name), ids, "none was dropped");
});
