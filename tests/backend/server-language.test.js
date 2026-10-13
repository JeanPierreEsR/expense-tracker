// Spanish/English for the texts the SERVER says (step 5b): the dictionary in
// backend/Strings.gs is complete, no fixed English error message sneaks back in
// outside it, and what the person sees follows the request's language (errors,
// descriptions the server writes, report labels, sign-in).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { freshApp } = require("./helpers");

const BACKEND = path.join(__dirname, "..", "..", "backend");
const files = fs.readdirSync(BACKEND).filter((f) => f.endsWith(".gs"));
const source = (f) => fs.readFileSync(path.join(BACKEND, f), "utf8");

// The dictionary, read from Strings.gs without running the rest of the backend.
const dictionary = (() => {
  const ctx = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(source("Strings.gs"), ctx);
  return vm.runInContext("BACKEND_STRINGS_", ctx);
})();
const placeholders = (v, form) => [...String(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => !(form === "one" && p === "n")).sort().join(",");
const forms = (v) => (typeof v === "object" ? { one: v.one, other: v.other } : { text: v });

test("every server text exists in both languages, filled in, with the same {placeholders}", () => {
  const keys = Object.keys(dictionary);
  assert.ok(keys.length > 100, "the dictionary is not empty");
  for (const key of keys) {
    const e = dictionary[key];
    assert.ok(e && e.en !== undefined && e.es !== undefined, `${key}: needs en and es`);
    assert.deepEqual(Object.keys(forms(e.en)), Object.keys(forms(e.es)), `${key}: plain vs one/other must match`);
    for (const form of Object.keys(forms(e.en))) {
      assert.ok(String(forms(e.en)[form]).trim() && String(forms(e.es)[form]).trim(), `${key}.${form}: empty text`);
      assert.equal(placeholders(forms(e.es)[form], form), placeholders(forms(e.en)[form], form), `${key}.${form}: {placeholders} differ`);
    }
  }
});

test("every tr_('key') the server asks for exists", () => {
  for (const f of files.filter((x) => x !== "Strings.gs")) {
    for (const m of source(f).matchAll(/\btr_\(\s*'([\w.]+)'/g)) assert.ok(dictionary[m[1]], `${f}: missing server text ${m[1]}`);
  }
  // tr_(cond ? 'a.b' : 'c.d') — also look at quoted keys inside a tr_( ... ) call on one line
  for (const f of files.filter((x) => x !== "Strings.gs")) {
    for (const m of source(f).matchAll(/\btr_\(([^;\n]*)/g)) {
      for (const k of m[1].matchAll(/'([a-z]+\.[\w.]+)'/g)) assert.ok(dictionary[k[1]], `${f}: missing server text ${k[1]}`);
    }
  }
});

// A new `throw new Error('fixed English')` would reach the app untranslated.
// Only internal/admin/owner-menu messages are allowed to stay as they are.
const FIXED_MESSAGES_ALLOWED = [
  "No token provided", "No URL provided", "Unknown action", "Sheet not found", "entryId is required",
  "Run \"1. Build sheet tabs\"", "Unknown photo job", "Could not download the image", "batchId required",
  "contains is required", "Category not found", "Unknown payment method", "Unknown ", "A confirmed entry needs a category",
  "Telegram bot token not set", "Unsupported language"
];
test("no fixed English error message outside the dictionary (internal and admin ones excepted)", () => {
  for (const f of files.filter((x) => x !== "Strings.gs" && x !== "Migrations.gs")) {
    source(f).split("\n").forEach((line, i) => {
      const m = line.match(/new Error\((['"])(.*?)\1/);
      if (!m) return;
      assert.ok(FIXED_MESSAGES_ALLOWED.some((ok) => m[2].startsWith(ok)), `${f}:${i + 1}: fixed English error "${m[2]}" — add it to Strings.gs and use tr_()`);
    });
  }
});

// ---- behaviour, end to end ------------------------------------------------------
const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

test("an error reaches the app in the language of the request", () => {
  const { rt } = freshApp({ entries: 50 });
  assert.equal(post(rt, "addLoan", { amount: 5 }, "es").error, "Elige un amigo.");
  assert.equal(post(rt, "addLoan", { amount: 5 }, "en").error, "Pick a friend.");
  assert.equal(post(rt, "addLoan", { amount: 5 }).error, "Pick a friend.", "no language = English");
  assert.equal(post(rt, "addBudget", { category_id: "ALL", amount: -1, currency: "PEN", period_type: "monthly" }, "es").error,
    "El monto del presupuesto debe ser un número mayor que 0.");
});

test("descriptions the server writes use the language active when they are created", () => {
  const { rt } = freshApp({ entries: 50 });
  const friend = rt.rows("Friends")[0];
  const loan = (lang) => post(rt, "addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-10-01" }, lang);
  assert.equal(loan("es").ok, true);
  assert.equal(loan("en").ok, true);
  const transfers = rt.rows("Entries").filter((e) => e.type === "transfer" && /Pr[eé]stamo a|Loan to/.test(e.description));
  const texts = transfers.map((e) => e.description);
  assert.ok(texts.includes(`Préstamo a ${friend.name}`), JSON.stringify(texts));
  assert.ok(texts.includes(`Loan to ${friend.name}`), JSON.stringify(texts));
  // a repayment too
  assert.equal(post(rt, "recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, currency: "PEN", date: "2026-10-02", overpay_category_id: "" }, "es").ok, true);
  assert.ok(rt.rows("Entries").some((e) => e.description === `Repago de ${friend.name}`));
});

test("reports: category names (and the fallback labels) follow the request's language", () => {
  const { rt } = freshApp({ entries: 300 });
  const groceries = rt.rows("Categories").find((c) => c.name === "Groceries" && c.type === "expense");
  rt.run(`createEntry({ type: 'expense', date: '2026-10-01', amount: 12.34, currency: 'PEN', category_id: ${JSON.stringify(groceries.id)}, description: 'untagged one', paid_by: 'me', payment_method_id: '' });`);
  const summary = (lang) => post(rt, "getPeriodSummary", { startDate: "2026-10-01", endDate: "2026-10-01" }, lang).data.breakdowns.expense;
  const es = summary("es"), en = summary("en");
  assert.ok(es.byCategory.some((x) => x.name === "Supermercado"));
  assert.ok(en.byCategory.some((x) => x.name === "Groceries"));
  // The fallback names (a dangling tag/category reference) come from the dictionary too.
  assert.equal(rt.run("tr_('report.untagged', null, 'es')"), "Sin etiqueta");
  assert.equal(rt.run("tr_('report.untagged', null, 'en')"), "Untagged");
  assert.equal(rt.run("tr_('report.uncategorized', null, 'es')"), "Sin categoría");
});

test("sign-in errors carry a code the app can rely on, and their text follows the language", () => {
  const { rt } = freshApp({ entries: 50 });
  const wrongEs = rt.rawPost(JSON.stringify({ action: "login", payload: { code: "nope", deviceName: "t" }, lang: "es" }));
  assert.equal(wrongEs.ok, false);
  assert.equal(wrongEs.code, "wrong_code");
  assert.equal(wrongEs.error, "Código de acceso incorrecto.");
  const wrongEn = rt.rawPost(JSON.stringify({ action: "login", payload: { code: "nope", deviceName: "t" } }));
  assert.equal(wrongEn.error, "Wrong access code.");
  const bad = rt.rawPost(JSON.stringify({ accessCode: "bad", action: "getMeta", payload: {}, lang: "es" }));
  assert.equal(bad.code, "invalid_access_code");
  assert.equal(bad.error, "Código de acceso no válido");
  assert.equal(rt.rawPost(JSON.stringify({ accessCode: "bad", action: "getMeta", payload: {} })).error, "Invalid access code", "old app copies still see the old text");
});
