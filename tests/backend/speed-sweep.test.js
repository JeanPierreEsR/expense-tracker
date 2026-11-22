// Speed sweep (2026-11-21): the shortcuts must give exactly the old answers. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("Needs review: twins and card-charge matches are the same as a scan of every entry", () => {
  const { rt } = freshApp({});
  // Plant look-alikes: a copy of two waiting entries (same day, amount, name) and one confirmed by hand a day later.
  rt.run(`(function () {
    var p = getAllRows('Entries').filter(function (e) { return e.status === 'pending'; }).slice(0, 3);
    appendRowObject('Entries', Object.assign({}, p[0], { id: 'twin-a' }));
    appendRowObject('Entries', Object.assign({}, p[1], { id: 'twin-b' }));
    appendRowObject('Entries', Object.assign({}, p[2], { id: 'twin-c', status: 'confirmed', source: 'manual', description: 'Other name' }));
  })()`);
  const list = rt.api("listPendingEntries", { lang: "en" });
  assert.ok(list.length > 20, "the made-up data has waiting entries: " + list.length);
  const old = JSON.parse(rt.run(`(function () {
    var all = getAllRows('Entries');
    return JSON.stringify(all.filter(function (e) { return e.status === 'pending'; }).map(function (e) {
      return { id: e.id, twins: findSameDayTwins_(e, all), charge: chargeMatchForReview_(e, all) };
    }));
  })()`));
  const byId = {};
  list.forEach((e) => { byId[e.id] = e; });
  let withTwins = 0;
  old.forEach((o) => {
    const e = byId[o.id];
    assert.deepEqual(e.twins, o.twins, "twins of " + o.id);
    assert.deepEqual(e.charge_match || null, o.charge, "charge of " + o.id);
    if (o.twins.length) withTwins++;
  });
  assert.ok(withTwins > 0, "some waiting entries have twins, so the check means something");
});

test("a setting or category changed in the middle of a request is seen at once by the rest of that request", () => {
  const { rt } = freshApp({});
  const out = JSON.parse(rt.run(`(function () {
    return JSON.stringify(withRowsMemo_(function () {
      var before = getSettingsMap().speed_probe;
      setSetting_('speed_probe', 'one');
      var mid = getSettingsMap().speed_probe;
      setSetting_('speed_probe', 'two');
      var after = getSettingsMap().speed_probe;
      var n = getAllRowsCached_('Categories').length;
      appendRowObject('Categories', { id: 'probe-cat', name: 'Probe', type: 'expense' });
      bumpStructureVersion_();
      var n2 = getAllRowsCached_('Categories').length;
      return { before: before || '', mid: mid, after: after, grew: n2 - n };
    }));
  })()`));
  assert.deepEqual(out, { before: "", mid: "one", after: "two", grew: 1 });
});

test("a looking call asks the property store for a version once, not once per reference list", () => {
  const { rt } = freshApp({});
  rt.api("getMeta", {});
  const n = Number(rt.run(`(function () {
    var calls = 0, real = PropertiesService.getScriptProperties;
    PropertiesService.getScriptProperties = function () { var p = real.call(PropertiesService); var g = p.getProperty;
      return Object.assign(Object.create(p), { getProperty: function (k) { if (/VERSION/.test(k)) calls++; return g.call(p, k); } }); };
    try { routeAction('listPendingEntries', { lang: 'en' }); } finally { PropertiesService.getScriptProperties = real; }
    return calls;
  })()`));
  assert.ok(n <= 3, "version asked " + n + " times (was ~200: once per waiting entry)");
});

test("Import's preview reads the Programmed items once, not once per line (Andrés, testers 2026-11-21)", () => {
  const { rt } = freshApp({ entries: 300 });
  const cats = rt.rows("Categories").filter((c) => c.type === "expense").slice(0, 4).map((c) => c.name);
  const lines = Array.from({ length: 300 }, (_, i) => ({ date: `2024-${String((i % 12) + 1).padStart(2, "0")}-1${i % 9}`, description: "Line " + i,
    amount: -(10 + (i % 50)), currency: "PEN", category: cats[i % cats.length] }));
  const statements = [{ key: "NOACCOUNT", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "big.csv",
    period: { start: "2024-01-10", end: "2024-12-18" }, lines }];
  rt.stats.bySheet = {};
  rt.run(`planStatementHistory(${JSON.stringify({ statements })})`);
  const reads = rt.stats.bySheet;
  delete rt.stats.bySheet;
  assert.ok((reads["Recurring Expenses"] || 0) <= 2, "Programmed items read " + reads["Recurring Expenses"] + " times");
  assert.ok((reads["Recurring Expense Splits (1 row)"] || 0) + (reads["Recurring Expense Splits"] || 0) <= 4, "their splits read too often (a few fixed reads, not one per line): " + JSON.stringify(reads));
});

test("a Programmed item match is the same with the lists read once as with each read on its own", () => {
  const { rt } = freshApp({});
  const same = rt.run(`(function () {
    var all = getAllRows('Entries'), lists = planMatchLists_(), n = 0, diff = 0;
    all.filter(function (e) { return (e.type === 'expense' || e.type === 'income') && !e.recurring_expense_id; }).slice(0, 400).forEach(function (e) {
      var a = JSON.stringify(planMatchFor_(e, all)), b = JSON.stringify(planMatchFor_(e, all, lists));
      n++; if (a !== b) diff++;
    });
    return JSON.stringify({ n: n, diff: diff });
  })()`);
  const r = JSON.parse(same);
  assert.ok(r.n > 50);
  assert.equal(r.diff, 0);
});
