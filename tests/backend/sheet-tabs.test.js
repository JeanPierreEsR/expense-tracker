// Tidy Sheet tabs (owner, 2026-11-28): the app's tabs in six groups, coloured, logs hidden, header rows frozen, an empty "Sheet1"
// removed; the person's own tabs left alone; afterwards only NEW tabs are placed (never one the person moved or showed again).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const names = (rt) => rt.svc.ss.getSheets().map((s) => s.getName());
const sheet = (rt, n) => rt.svc.ss.getSheetByName(n);
const move = (rt, n, pos) => { rt.svc.ss.setActiveSheet(sheet(rt, n)); rt.svc.ss.moveActiveSheet(pos); };
const wantedAll = (rt) => plain(rt.run("sheetTabGroups_().reduce(function (a, g) { return a.concat(g.tabs); }, [])"));

function messy() {
  const { rt } = freshApp({ small: true });
  rt.svc.ss.insertSheet("Sheet1");
  move(rt, "Sheet1", 1);
  const own = rt.svc.ss.insertSheet("Mis notas");
  own.appendRow(["hola"]);
  move(rt, "Mis notas", 3);
  move(rt, "Settings", 2);     // core tabs scattered, as on the owner's copy
  move(rt, "Entries", names(rt).length);
  return rt;
}

test("the full tidy: groups in order, own tab last and untouched, logs hidden, headers frozen, empty Sheet1 gone, no cell changed", () => {
  const rt = messy();
  const entriesBefore = JSON.stringify(sheet(rt, "Entries").rows);
  const done = plain(rt.run("tidySheetTabs_()"));
  assert.deepEqual(done.removed, ["Sheet1"]);
  const after = names(rt);
  const order = wantedAll(rt);
  const known = after.filter((n) => order.includes(n));
  assert.deepEqual(known, order.filter((n) => after.includes(n)), "the app's tabs follow the group order");
  assert.equal(after[0], "Entries");
  assert.equal(after[after.length - 1], "Mis notas", "the person's own tab goes after the app's");
  const mine = sheet(rt, "Mis notas");
  assert.equal(mine.getTabColor(), null);
  assert.equal(mine.isSheetHidden(), false);
  assert.equal(mine.getFrozenRows(), 0);
  assert.equal(sheet(rt, "Entries").getTabColor(), "#34a853");
  assert.equal(sheet(rt, "Entries").getFrozenRows(), 1);
  assert.equal(sheet(rt, "Friends").getTabColor(), "#4285f4");
  assert.equal(sheet(rt, "Entries").isSheetHidden(), false);
  assert.equal(sheet(rt, "Sessions").isSheetHidden(), true, "the app's logs are hidden");
  assert.equal(sheet(rt, "Telegram Messages").isSheetHidden(), true);
  assert.equal(JSON.stringify(sheet(rt, "Entries").rows), entriesBefore, "no cell changes");
  assert.equal(plain(rt.run("tidySheetTabs_()")).moved, 0, "running it again changes nothing");
});

test("done in pieces: each call stops at its time budget and the next carries on, ending exactly like the one-go tidy", () => {
  const rt = messy();
  const oneGo = messy();
  oneGo.run("tidySheetTabs_()");
  rt.run("var __clock = 0; Date.now = function () { return (__clock += 300); };");   // every step costs 0.3 s
  let calls = 0, r;
  do { r = plain(rt.run("tidySheetTabs_(1000)")); calls++; } while (!r.finished && calls < 200);
  assert.ok(r.finished);
  assert.ok(calls > 3, "it took several pieces (" + calls + ")");
  assert.deepEqual(names(rt), names(oneGo));
  assert.equal(sheet(rt, "Sessions").isSheetHidden(), true);
  assert.equal(sheet(rt, "Friends").getTabColor(), "#4285f4");
});

test("another call already at it: this one does nothing", () => {
  const rt = messy();
  const before = names(rt);
  rt.svc.props.set("SHEET_TABS_TIDY_BUSY_AT", String(Date.now()));
  assert.equal(plain(rt.run("tidySheetTabs_(1000)")).finished, false);
  assert.deepEqual(names(rt), before);
});

test("a copy with the timer: the app open does nothing, the timer tidies and marks the heal done", () => {
  const rt = messy();
  const before = names(rt);
  assert.equal(plain(rt.run("tidySheetTabsAtOpen_()")), false);
  assert.deepEqual(names(rt), before, "the app open never waits for the tidy");
  rt.run("runHealsOnce_()");
  assert.equal(plain(rt.run("healIsDone_('tidy-sheet-tabs')")), false);
  plain(rt.run("tidySheetTabsInBackground_()"));
  assert.equal(names(rt)[0], "Entries");
  assert.equal(plain(rt.run("healIsDone_('tidy-sheet-tabs')")), true);
  assert.equal(plain(rt.run("tidySheetTabsInBackground_()")), null, "nothing more once done");
});

test("a copy without the timer: each app open does a short piece until it is finished", () => {
  const rt = messy();
  rt.svc.props.set("FEATURES", "base");
  rt.run("var __clock = 0; Date.now = function () { return (__clock += 400); };");
  let opens = 0;
  while (!plain(rt.run("healIsDone_('tidy-sheet-tabs')")) && opens < 200) { rt.run("runHealsOnce_()"); opens++; }
  assert.ok(opens > 1, "spread over several opens (" + opens + ")");
  assert.equal(names(rt)[0], "Entries");
  assert.equal(sheet(rt, "Sessions").isSheetHidden(), true);
});

test("a Sheet1 with something in it is kept", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.ss.insertSheet("Sheet1").appendRow(["x"]);
  rt.run("tidySheetTabs_()");
  assert.ok(sheet(rt, "Sheet1"));
});

test("afterwards: a new app tab goes into its group; a tab the person moved or showed again stays as they left it", () => {
  const rt = messy();
  rt.run("tidySheetTabs_()");
  move(rt, "Friends", 1);                       // the person wants Friends first
  sheet(rt, "Sessions").showSheet();            // and looks at a log
  assert.ok(!sheet(rt, "Change Log"));
  rt.svc.ss.insertSheet("Change Log");          // Google puts a new tab near the front
  move(rt, "Change Log", 2);
  assert.ok(!sheet(rt, "Account Moves"));
  rt.svc.ss.insertSheet("Account Moves");
  move(rt, "Account Moves", 2);
  assert.equal(plain(rt.run("placeNewSheetTabs_()")), 2);
  const after = names(rt);
  assert.equal(after[0], "Friends", "not moved back");
  assert.equal(sheet(rt, "Sessions").isSheetHidden(), false, "not hidden again");
  assert.equal(sheet(rt, "Change Log").isSheetHidden(), true);
  assert.equal(sheet(rt, "Account Moves").getTabColor(), "#fa7b17");
  const order = wantedAll(rt);
  const rankOf = (n) => order.indexOf(n);
  const prev = after[after.indexOf("Account Moves") - 1];
  assert.ok(rankOf(prev) < rankOf("Account Moves"), "placed after an earlier tab of the order (" + prev + ")");
  const next = after[after.indexOf("Account Moves") + 1];
  assert.ok(rankOf(next) === -1 || rankOf(next) > rankOf("Account Moves") || next === "Friends", "and before a later one (" + next + ")");
  assert.equal(plain(rt.run("placeNewSheetTabs_()")), 0, "nothing new: nothing moves");
});

test("a copy never tidied: the hourly step does nothing", () => {
  const { rt } = freshApp({ small: true });
  const before = names(rt);
  assert.equal(plain(rt.run("placeNewSheetTabs_()")), 0);
  assert.deepEqual(names(rt), before);
});

test("every tab the app can make has a group (a new tab must be added to sheetTabGroups_)", () => {
  const { rt } = freshApp({ small: true });
  const listed = new Set(wantedAll(rt));
  const dir = path.join(__dirname, "../../backend");
  const src = fs.readdirSync(dir).filter((f) => f.endsWith(".gs")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const found = new Set();
  for (const m of src.matchAll(/insertSheet\('([^']+)'\)/g)) found.add(m[1]);
  for (const m of src.matchAll(/ensureStatementSheet_\('([^']+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/var [A-Z_]+_SHEET_ = '([^']+)'/g)) found.add(m[1]);
  plain(rt.run("Object.keys(TABLE_DEFINITIONS)")).forEach((n) => found.add(n));
  plain(rt.run("Object.keys(BUSINESS_TABLES_)")).forEach((n) => found.add(n));
  const missing = [...found].filter((n) => !listed.has(n));
  assert.deepEqual(missing, []);
});
