// "What fits you?": the starter categories of a new install, the packs each answer adds, and More → Categories → "Add suggested
// categories" (backend/Profile.gs + the welcome screens). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const doc = (...p) => fs.readFileSync(path.join(__dirname, "../..", ...p), "utf8");
const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const catNames = (rt, type) => rt.rows("Categories").filter((c) => c.type === type).map((c) => c.name);

// A new person's copy, as the installer builds it: FEATURES present, the Categories tab seeded again from scratch.
function friendCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  return rt;
}

test("the starter lists: 16 expense and 5 income categories, each with a Spanish name, an emoji and no duplicates", () => {
  const rt = freshApp({ small: true }).rt;
  const exp = run(rt, "STARTER_EXPENSE_CATEGORIES_"), inc = run(rt, "STARTER_INCOME_CATEGORIES_");
  assert.equal(exp.length, 16);
  assert.equal(inc.length, 5);
  for (const [name, icon] of exp.concat(inc)) {
    assert.ok(icon, `${name} has an emoji`);
    const key = rt.run(`categoryKeyFromName_(${JSON.stringify(name)})`);
    const t = run(rt, `CATEGORY_TRANSLATIONS_[${JSON.stringify(key)}] || null`);
    assert.ok(t ? t.en === name : /^[A-Za-z ]+$/.test(name), `${name}: a translation entry whose English name is the stored name (or a name that is the same in both languages)`);
  }
  assert.equal(new Set(exp.map((c) => c[0])).size, 16);
  assert.ok(["Bills & utilities", "Subscriptions", "Insurance", "Phone", "Gifts & donations"].every((n) => exp.some((c) => c[0] === n)), "the gaps the plan names");
  assert.ok(!exp.some((c) => ["AI", "Psychologist", "Party", "Credit card", "Work", "Sports", "Gym", "Mobile Phone", "Car"].includes(c[0])), "the retired / moved ones are not in the starter list");
  assert.ok(exp.some((c) => c[0] === "Other") && inc.some((c) => c[0] === "Other") && inc.some((c) => c[0] === "Refunds"), "names the code looks up stay");
});

test("every pack category has an emoji and a Spanish name, and every answer has a label in both languages", () => {
  const rt = freshApp({ small: true }).rt;
  const packs = run(rt, "PROFILE_PACKS_");
  const order = run(rt, "PROFILE_ORDER_");
  assert.deepEqual(order.slice().sort(), Object.keys(packs).sort());
  const strings = doc("docs", "strings.js");
  for (const a of order) {
    assert.match(strings, new RegExp(`"fits\\.a\\.${a}": \\{ en: .+, es: `), `label for ${a}`);
    for (const type of ["expense", "income"]) {
      for (const [name, icon] of packs[a][type] || []) {
        assert.ok(icon, `${name} has an emoji`);
        const key = rt.run(`categoryKeyFromName_(${JSON.stringify(name)})`);
        const t = run(rt, `CATEGORY_TRANSLATIONS_[${JSON.stringify(key)}] || null`);
        assert.ok(t && t.en === name && t.es && t.es !== t.en, `${name} has a Spanish name`);
      }
    }
  }
});

test("a new install starts with the short starter lists; the owner's copy keeps his own long one", () => {
  const rt = friendCopy();
  assert.deepEqual(catNames(rt, "expense"), run(rt, "STARTER_EXPENSE_CATEGORIES_").map((c) => c[0]));
  assert.deepEqual(catNames(rt, "income"), run(rt, "STARTER_INCOME_CATEGORIES_").map((c) => c[0]));
  assert.ok(catNames(rt, "investment").includes("Contribution") && catNames(rt, "transfer").includes("Between Accounts"), "the system categories are still there");
  const owner = freshApp({ small: true }).rt;
  assert.ok(catNames(owner, "expense").includes("Psychologist") && catNames(owner, "expense").includes("Credit card"), "the owner's long list is untouched");
});

test("a pack adds only its categories, in the person's language, and the answers are remembered", () => {
  const rt = friendCopy();
  const res = post(rt, "applyProfile", { answers: ["selfemployed", "car", "nonsense"] }, "es").data;
  assert.deepEqual(res.profile, ["car", "selfemployed"], "unknown answers are ignored, the rest keep the app's order");
  assert.deepEqual(res.added.map((a) => a.name), ["Auto", "Combustible", "Estacionamiento y peajes", "Software y herramientas", "Ventas"]);
  assert.ok(catNames(rt, "expense").includes("Fuel") && catNames(rt, "income").includes("Sales"), "stored under the English names");
  assert.equal(rt.rows("Settings").find((s) => s.key === "profile").value, "car,selfemployed");
  const meta = post(rt, "getMeta", {}, "es").data;
  assert.ok(meta.categories.some((c) => c.name === "Mascotas") === false, "nothing else was added");
  assert.ok(meta.categories.some((c) => c.name === "Combustible"), "shown in Spanish");
  assert.equal(meta.settings.profile, "car,selfemployed", "the app can see the answers");
});

test("running it again adds nothing; a pack for 'invest' or 'split' adds no category at all", () => {
  const rt = friendCopy();
  post(rt, "applyProfile", { answers: ["car", "pets"] });
  const before = rt.rows("Categories").length;
  const again = post(rt, "applyProfile", { answers: ["car", "pets"] }).data;
  assert.equal(again.added.length, 0);
  const noCats = post(rt, "applyProfile", { answers: ["invest", "split"] }).data;
  assert.equal(noCats.added.length, 0);
  assert.equal(rt.rows("Categories").length, before);
  assert.equal(noCats.profile.join(","), "invest,split");
});

test("people who already use the app: nothing they have is duplicated, changed or removed; the gaps are filled", () => {
  const { rt } = freshApp({ small: true });
  const before = rt.rows("Categories").map((c) => `${c.type}:${c.name}`);
  const res = post(rt, "applyProfile", { answers: ["car", "sports", "health"], basics: true }).data;
  const added = res.added.map((a) => a.name);
  for (const covered of ["Car", "Gym & sports", "Therapy", "Phone", "Gifts & donations", "Groceries", "Salary"]) {
    assert.ok(!added.includes(covered), `${covered} is covered by what the copy already has`);
  }
  for (const gap of ["Bills & utilities", "Subscriptions", "Insurance", "Fuel", "Parking & tolls"]) assert.ok(added.includes(gap), `${gap} is a gap`);
  const after = rt.rows("Categories").map((c) => `${c.type}:${c.name}`);
  for (const b of before) assert.ok(after.includes(b), `${b} is still there`);
  assert.equal(after.length, before.length + added.length);
  assert.equal(new Set(after).size, after.length, "no duplicate names");
});

test("the insurance e-mail rule falls back to Insurance on a copy that has no 'Credit card' category", () => {
  const { rt } = freshApp({ small: true });
  const guess = (names) => run(rt, `guessCategoryForEmail_({ type: 'expense', merchant: 'Crecer Seguros', defaultCategory: 'Credit card', defaultCategoryAlt: 'Insurance' }, '2026-10-01', { expenseCatIdByName: ${JSON.stringify(names)}, transferCatId: 't' })`);
  assert.equal(guess({ "Credit card": "cc", Insurance: "ins" }).categoryId, "cc", "the owner's copy still files it as before");
  assert.equal(guess({ Insurance: "ins" }).categoryId, "ins", "a new install files it under Insurance");
  const src = doc("backend", "EmailParser.gs");
  assert.match(src, /defaultCategory: 'Credit card', defaultCategoryAlt: 'Insurance'/);
});

test("a backend that can do it says so in its capabilities", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(post(rt, "getMeta", {}).data.capabilities.profile, true);
});

test("the welcome has the 'What fits you?' screen with the Business question on it, and the platforms step only for people who invest", () => {
  const html = doc("docs", "index.html");
  const app = doc("docs", "app.js");
  const fits = html.indexOf('<div id="welcome-fits" hidden>');
  const accounts = html.indexOf('<div id="welcome-accounts" hidden>');
  const wb = html.indexOf('<div id="wb-block" hidden>');
  assert.ok(fits > 0 && fits < wb && wb < accounts, "the Business question sits on the new screen");
  assert.ok(html.indexOf('<div id="welcome-platforms" hidden>') > accounts && !/id="wb-block"[\s\S]{0,40}<\/div>[\s\S]*id="wp-error"/.test(html.slice(html.indexOf('<div id="welcome-platforms" hidden>'), html.indexOf('<div id="welcome-tour" hidden>'))), "and no longer on the platforms screen");
  assert.match(app, /if \(welcome_\.fits\.includes\("invest"\)\) showWelcomeStep_\(4\);\s*\n\s*else finishWelcome_\("accounts"\)/);
  assert.match(app, /welcome_\.fits\.length && meta && meta\.capabilities && meta\.capabilities\.profile/, "an older backend is never asked");
  assert.match(app, /categories-suggest-btn"\)\.hidden = !\(meta && meta\.capabilities && meta\.capabilities\.profile\)/);
  assert.match(doc("docs", "strings.js"), /"welcome\.step": \{ en: "Step \{n\} of 4"/);
});
