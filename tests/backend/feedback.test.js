// "Send me feedback" notes (backend/Feedback.gs). Made-up ids, names and text only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const post = (rt, body) => rt.rawPost(JSON.stringify(body));
const INSTALL_A = "0f8c1c5e-1111-4a2b-9c3d-aaaaaaaaaaaa";
const note = (rt, payload) => post(rt, { action: "reportFeedback", payload: { install: INSTALL_A, label: "Ana", kind: "broke", screen: "overview", language: "es", app: "0.10.2", device: "iPhone (home screen)", text: "The chart does not load when I open Overview", ...payload } });
const stored = (rt) => rt.rows("Feedback");

test("a note needs no sign-in and lands in the Feedback tab, in English, and on Telegram", () => {
  const { rt } = freshApp({ small: true });
  linkTelegram(rt);
  const res = note(rt, {});
  assert.equal(res.ok, true);
  const [r] = stored(rt);
  assert.deepEqual([r.install_id, r.label, r.kind, r.screen, r.language, r.app_version, r.device, r.text],
    [INSTALL_A, "Ana", "broke", "overview", "es", "0.10.2", "iPhone (home screen)", "The chart does not load when I open Overview"]);
  assert.match(String(r.received_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const said = rt.svc.fetchLog.map((f) => String(f.options.payload)).filter((p) => p.includes("Feedback from Ana") || p.includes("Comentario de Ana"));
  assert.equal(said.length, 1, "one Telegram heads-up");
  assert.ok(said[0].includes("The chart does not load"));
});

test("e-mail addresses and long numbers are hidden again by the backend, whatever the phone did", () => {
  const { rt } = freshApp({ small: true });
  note(rt, { text: "Write to ana.lo@example.com or call 987 654 321 about card 4111-1111-1111-1111, build 0.10.1 stays" });
  const text = stored(rt)[0].text;
  assert.ok(!text.includes("example.com") && !text.includes("987 654") && !text.includes("4111"));
  assert.ok(text.includes("[email]") && text.includes("[number]"));
  assert.ok(text.includes("0.10.1"), "a version number is not hidden");
});

test("the kind, screen, language, app version and phone type are reduced to safe values", () => {
  const { rt } = freshApp({ small: true });
  note(rt, { screen: "=HYPERLINK(1)", language: "fr", app: "<script>", device: "=cmd|' /C calc'!A0" });
  const r = stored(rt)[0];
  assert.deepEqual([r.screen, r.language, r.app_version, r.device], ["", "en", "", "Other"]);
  assert.equal(note(rt, { kind: "complaint" }).ok, false);
  assert.equal(stored(rt).length, 1);
});

test("a note that is too short, or a bad install id, is refused and creates nothing", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(note(rt, { text: "hi" }).ok, false);
  assert.equal(note(rt, { text: "     \n  " }).ok, false);
  for (const bad of ["", "short", "../../etc", "=1+1"]) assert.equal(note(rt, { install: bad }).ok, false, bad);
  assert.equal(rt.run("!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Feedback')"), false);
});

test("a very long note is cut to 1,000 characters and a name typed as a formula is cleaned", () => {
  const { rt } = freshApp({ small: true });
  note(rt, { text: "word ".repeat(400), label: "=HYPERLINK(\"http://x\",\"hi\")" });
  const r = stored(rt)[0];
  assert.ok(r.text.length <= 1000);
  assert.equal(r.label, "HYPERLINKhttpxhi");
});

test("a note that starts like a formula stays plain text in the sheet", () => {
  const { rt } = freshApp({ small: true });
  note(rt, { text: "=1+1 is what the screen shows after I tap" });
  assert.equal(stored(rt)[0].text, "=1+1 is what the screen shows after I tap");
  assert.equal(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Feedback').getRange(2,9).getFormula ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Feedback').getRange(2,9).getFormula() : ''"), "");
});

test("one phone can send 10 notes a day, then it is told to try tomorrow; nothing else is lost", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 10; i++) assert.equal(note(rt, { text: "note number " + i + " about the app" }).ok, true);
  const over = note(rt, { text: "one more note about the app" });
  assert.equal(over.ok, false);
  assert.equal(over.code, "feedback_busy");
  assert.equal(stored(rt).length, 10);
});

test("a friend's own copy refuses notes, and a Telegram failure never loses a note", () => {
  const friend = freshApp({ small: true });
  friend.rt.svc.props.set("FEATURES", "gmail,keepawake");
  const res = note(friend.rt, {});
  assert.equal(res.ok, false);
  assert.equal(res.code, "feedback_not_collected");
  const { rt } = freshApp({ small: true });   // no Telegram linked: the notice fails quietly
  assert.equal(note(rt, {}).ok, true);
  assert.equal(stored(rt).length, 1);
});

test("the Feedback tab is created once, with English headers, and a note never needs or counts as an access code", () => {
  const { rt } = freshApp({ small: true });
  for (let i = 0; i < 12; i++) note(rt, { text: "note number " + i + " for the tab", install: i < 6 ? INSTALL_A : "0f8c1c5e-2222-4a2b-9c3d-bbbbbbbbbbbb" });
  const sheets = rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); })");
  assert.equal(sheets.filter((n) => n === "Feedback").length, 1);
  assert.deepEqual(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Feedback').getRange(1,1,1,9).getValues()[0]"),
    ["received_at", "install_id", "label", "kind", "screen", "language", "app_version", "device", "text"]);
  assert.equal(post(rt, { accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }).ok, true);
});
