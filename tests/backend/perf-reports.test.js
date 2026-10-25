// App-speed reports from friends' phones (backend/PerfReports.gs). Made-up ids, names and numbers only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const INSTALL_A = "0f8c1c5e-1111-4a2b-9c3d-aaaaaaaaaaaa";
const INSTALL_B = "0f8c1c5e-2222-4a2b-9c3d-bbbbbbbbbbbb";

const entry = (s, extra = {}) => ({ s, t: Date.now() - 1000, k: "call", n: "listEntries", tm: 800 + s, sm: 300, c: false, a: 1, o: true, ...extra });
const report = (rt, payload) => post(rt, { action: "reportPerf", payload: { install: INSTALL_A, label: "Ana", app: "2026-10-16T15:35:05Z", device: "iPhone (home screen)", ...payload } });
const stored = (rt) => rt.rows("Perf Reports");

test("a report needs no sign-in and is appended to the Perf Reports tab, in English", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { entries: [entry(1), entry(2, { k: "startup", n: "open→usable", a: undefined, sm: undefined })] });
  assert.equal(res.ok, true);
  assert.deepEqual([res.data.ack, res.data.stored], [2, 2]);
  const rows = stored(rt);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].install_id, INSTALL_A);
  assert.equal(rows[0].label, "Ana");
  assert.equal(rows[0].action, "listEntries");
  assert.equal(rows[0].kind, "call");
  assert.equal(rows[0].device, "iPhone (home screen)");
  assert.match(String(rows[0].at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(rows[1].action, "open→usable");
});

test("sending the same report again adds nothing (no duplicates)", () => {
  const { rt } = freshApp({ small: true });
  const batch = [entry(1), entry(2), entry(3)];
  report(rt, { entries: batch });
  const again = report(rt, { entries: batch });
  assert.equal(again.ok, true);
  assert.deepEqual([again.data.ack, again.data.stored], [3, 0]);
  assert.equal(stored(rt).length, 3);
});

test("a report that overlaps what is already stored only adds the new entries", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [1, 2, 3, 4, 5].map((s) => entry(s)) });
  const res = report(rt, { entries: [3, 4, 5, 6, 7, 8].map((s) => entry(s)) });
  assert.deepEqual([res.data.ack, res.data.stored], [8, 3]);
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("the same entry number twice in one request is stored once", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [entry(1), entry(1), entry(2)] });
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [1, 2]);
});

test("each install has its own numbering, so two phones never cancel each other out", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [entry(1), entry(2)] });
  report(rt, { install: INSTALL_B, label: "Luis", entries: [entry(1), entry(2)] });
  const rows = stored(rt);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.label), ["Ana", "Ana", "Luis", "Luis"]);
});

test("only the fixed timing fields are kept; anything else a report carries never reaches the sheet", () => {
  const { rt } = freshApp({ small: true });
  report(rt, {
    secret: "SENTINEL-top", accessCode: rt.ACCESS_CODE,
    entries: [entry(1, { amount: "SENTINEL-amount", description: "SENTINEL-desc", friend: "SENTINEL-friend" })]
  });
  const all = JSON.stringify([...stored(rt)]);
  assert.ok(!all.includes("SENTINEL"));
  assert.ok(!all.includes(rt.ACCESS_CODE));
  assert.equal(stored(rt).length, 1);
});

test("malformed entries are dropped but acknowledged, so a phone never keeps resending them", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { entries: [
    entry(1), entry(2, { n: "a name with =FORMULA()" }), entry(3, { tm: -5 }), entry(4, { k: "other" }),
    entry(5, { tm: "12abc" }), entry(6, { t: 5 }), "junk", null, entry(7)
  ] });
  assert.equal(res.ok, true);
  assert.deepEqual(stored(rt).map((r) => Number(r.seq)), [1, 7]);
  assert.equal(res.data.ack, 7);
});

test("a name typed as a spreadsheet formula is cleaned so it cannot run", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { label: "=HYPERLINK(\"http://x\",\"hi\")", entries: [entry(1)] });
  report(rt, { install: INSTALL_B, label: "  @+-José María_Q.  ", entries: [entry(1)] });
  report(rt, { install: "0f8c1c5e-3333-4a2b-9c3d-cccccccccccc", label: "", entries: [entry(1)] });
  const labels = stored(rt).map((r) => r.label);
  for (const l of labels) assert.ok(!/^[=+\-@]/.test(l), l);
  assert.equal(labels[0], "HYPERLINKhttpxhi");
  assert.equal(labels[1], "José María_Q.");
  assert.equal(labels[2], "(no name)");
});

test("a very long name is cut to 30 characters", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { label: "x".repeat(200), entries: [entry(1)] });
  assert.equal(stored(rt)[0].label.length, 30);
});

test("an unknown phone type or odd app version is replaced by a safe value", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { device: "=cmd|' /C calc'!A0", app: "<script>", entries: [entry(1)] });
  const r = stored(rt)[0];
  assert.equal(r.device, "Other");
  assert.equal(r.app_version, "");
});

test("an install id that is not a random id is refused", () => {
  const { rt } = freshApp({ small: true });
  for (const bad of ["", "short", "../../etc", "=1+1", "x".repeat(60)]) {
    const res = report(rt, { install: bad, entries: [entry(1)] });
    assert.equal(res.ok, false, bad);
  }
  assert.equal(rt.run("!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Perf Reports')"), false, "a refused report creates nothing");
});

test("at most 200 entries are taken per request, and the acknowledgement stops there", () => {
  const { rt } = freshApp({ small: true });
  const res = report(rt, { entries: Array.from({ length: 250 }, (_, i) => entry(i + 1)) });
  assert.deepEqual([res.data.ack, res.data.stored], [200, 200]);
  const next = report(rt, { entries: Array.from({ length: 50 }, (_, i) => entry(i + 201)) });
  assert.deepEqual([next.data.ack, next.data.stored], [250, 50]);
  assert.equal(stored(rt).length, 250);
});

test("one phone cannot add more than 4,000 entries in a day (it is told to try later, nothing is lost)", () => {
  const { rt } = freshApp({ small: true });
  let seq = 0;
  for (let i = 0; i < 20; i++) report(rt, { entries: Array.from({ length: 200 }, () => entry(++seq)) });
  assert.equal(stored(rt).length, 4000);
  const over = report(rt, { entries: Array.from({ length: 10 }, () => entry(++seq)) });
  assert.equal(over.ok, false);
  assert.equal(over.code, "perf_busy");
  assert.equal(stored(rt).length, 4000);
  // the refused entries were not acknowledged: the phone still has them and re-sends them tomorrow
  const retry = report(rt, { entries: [entry(4001)] });
  assert.equal(retry.ok, false);
});

test("a friend's own copy refuses these reports (only the owner's copy collects them)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "gmail,keepawake");
  const res = report(rt, { entries: [entry(1)] });
  assert.equal(res.ok, false);
  assert.equal(res.code, "perf_not_collected");
});

test("reports never need, accept or count as a wrong access code", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 15; i++) assert.equal(report(rt, { entries: [entry(i + 1)] }).ok, true);
  assert.equal(post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }).ok, true);
});

test("the Perf Reports tab is created once, with English headers, and nothing else edits it", () => {
  const { rt } = freshApp({ small: true });
  report(rt, { entries: [entry(1)] });
  report(rt, { entries: [entry(2)] });
  const sheets = rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); })");
  assert.equal(sheets.filter((n) => n === "Perf Reports").length, 1);
  assert.deepEqual(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Perf Reports').getRange(1,1,1,14).getValues()[0]"),
    ["received_at", "install_id", "label", "seq", "at", "kind", "action", "total_ms", "server_ms", "cold", "attempts", "ok", "app_version", "device"]);
});

test("near the row limit the owner gets one Telegram heads-up; at the limit reports are refused, never silently dropped", () => {
  const { rt } = freshApp({ small: true });
  require("./helpers").linkTelegram(rt);
  rt.run("PERF_MAX_ROWS_ = 20");
  const said = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).filter((p) => p.includes("Perf Reports"));
  report(rt, { entries: Array.from({ length: 15 }, (_, i) => entry(i + 1)) });   // 15 of 20 is 75%: no warning yet
  assert.equal(said().length, 0);
  report(rt, { entries: [entry(16)] });                                          // 16 of 20 is 80%
  assert.equal(said().length, 1, "one heads-up");
  report(rt, { entries: [entry(17)] });
  assert.equal(said().length, 1, "and not again");
  const full = report(rt, { entries: Array.from({ length: 10 }, (_, i) => entry(i + 18)) });
  assert.equal(full.ok, false);
  assert.equal(full.code, "perf_full");
  assert.equal(stored(rt).length, 17, "nothing half-written");
  // refused without acknowledging: the same entries are accepted later, once there is room
  rt.run("PERF_MAX_ROWS_ = 300000");
  const later = report(rt, { entries: Array.from({ length: 10 }, (_, i) => entry(i + 18)) });
  assert.deepEqual([later.ok, later.data.ack, later.data.stored], [true, 27, 10]);
});

test("the Mac helper key gets counts of app releases in use (newest report per phone, no names, Owner left out)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("HELPER_KEY", "h".repeat(32));
  const INSTALL_C = "0f8c1c5e-3333-4a2b-9c3d-cccccccccccc";
  report(rt, { app: "0.40.0", entries: [entry(1)] });
  report(rt, { app: "0.46.0", entries: [entry(2)] });                        // Ana moved on: only this one counts
  report(rt, { install: INSTALL_B, label: "Bea", app: "0.46.0", entries: [entry(1)] });
  report(rt, { install: INSTALL_C, label: "Owner", app: "0.46.6", entries: [entry(1)] });
  const res = post(rt, { helperKey: "h".repeat(32), action: "listPerfAppVersions", payload: {} });
  assert.equal(res.ok, true);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(res.data, { releases: { "0.46.0": { installs: 2, lastSeen: today } } });
  assert.equal(JSON.stringify(res.data).includes("Ana"), false);
  assert.equal(post(rt, { helperKey: "wrong", action: "listPerfAppVersions", payload: {} }).ok, false);
});
