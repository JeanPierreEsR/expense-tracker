// "What fits you?": the basic categories of a new install, the two question groups ("My responsibilities", "My lifestyle") whose picks each add exactly one
// category, and More → Categories → "Add suggested categories" (backend/Profile.gs + the welcome screens). Made-up data only.
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

test("the basic lists: 8 expense categories (owner's list) and 5 income ones, each with an emoji, a Spanish name and no duplicates", () => {
  const rt = freshApp({ small: true }).rt;
  const exp = run(rt, "STARTER_EXPENSE_CATEGORIES_"), inc = run(rt, "STARTER_INCOME_CATEGORIES_");
  assert.deepEqual(exp.map((c) => c[0]), ["Groceries", "Restaurants", "Home", "Transport", "Travel", "Sports", "Bank fees", "Other"]);
  assert.equal(inc.length, 5);
  for (const [name, icon] of exp.concat(inc)) {
    assert.ok(icon, `${name} has an emoji`);
    const key = rt.run(`categoryKeyFromName_(${JSON.stringify(name)})`);
    const t = run(rt, `CATEGORY_TRANSLATIONS_[${JSON.stringify(key)}] || null`);
    assert.ok(t ? t.en === name : /^[A-Za-z ]+$/.test(name), `${name}: a translation entry whose English name is the stored name (or a name that is the same in both languages)`);
  }
  assert.equal(new Set(exp.map((c) => c[0])).size, 8);
  assert.ok(!exp.some((c) => ["Bills & utilities", "Phone", "Healthcare", "Education", "Insurance", "Family & Personal", "AI", "Credit card", "Car"].includes(c[0])), "household bills belong in Home; the rest are picks");
  assert.ok(exp.some((c) => c[0] === "Other") && inc.some((c) => c[0] === "Other") && inc.some((c) => c[0] === "Refunds"), "names the code looks up stay");
});

test("two question groups (8 + 7 answers); each answer adds exactly one category with an emoji and a Spanish name, and has a label in both languages", () => {
  const rt = freshApp({ small: true }).rt;
  const packs = run(rt, "PROFILE_PACKS_");
  const groups = run(rt, "PROFILE_GROUPS_");
  assert.deepEqual(groups.life, ["car", "kids", "pets", "study", "health", "selfemployed", "family", "debt"]);
  assert.deepEqual(groups.spheres, ["shopping", "goingout", "entertainment", "personal", "subscriptions", "hobbies", "gifts"]);
  assert.deepEqual(run(rt, "PROFILE_ORDER_"), groups.life.concat(groups.spheres));
  assert.deepEqual(Object.keys(packs).sort(), groups.life.concat(groups.spheres).sort());
  const strings = doc("docs", "strings.js");
  const app = doc("docs", "app.js");
  for (const a of Object.keys(packs)) {
    assert.match(strings, new RegExp(`"fits\\.a\\.${a}": \\{ en: .+, es: `), `label for ${a}`);
    assert.ok(app.includes(`"${a}"`), `${a} is drawn by the app`);
    const all = (packs[a].expense || []).concat(packs[a].income || []);
    assert.equal(all.length, 1, `${a} adds exactly one category`);
    const [name, icon] = all[0];
    assert.ok(icon, `${name} has an emoji`);
    const key = rt.run(`categoryKeyFromName_(${JSON.stringify(name)})`);
    const t = run(rt, `CATEGORY_TRANSLATIONS_[${JSON.stringify(key)}] || null`);
    assert.ok(t && t.en === name && t.es, `${name} has a Spanish name`);
  }
  assert.match(strings, /"fits\.g\.life": \{ en: "My responsibilities"/);
  assert.match(strings, /"fits\.g\.spheres": \{ en: "My lifestyle"/);
});

test("the labels say what each pick means: entertainment is shows and concerts, streaming is subscriptions, games are hobbies", () => {
  const strings = doc("docs", "strings.js");
  assert.match(strings, /"fits\.a\.entertainment": \{ en: "[^"]*shows, concerts/);
  assert.match(strings, /"fits\.a\.subscriptions": \{ en: "[^"]*streaming/);
  assert.match(strings, /"fits\.a\.hobbies": \{ en: "[^"]*games/);
  assert.match(strings, /"wf\.basics": \{ en: "Always included: Groceries, Restaurants, Home \(with your household bills\)/);
});

test("a new install starts with the basic lists; the owner's copy keeps his own long one", () => {
  const rt = friendCopy();
  assert.deepEqual(catNames(rt, "expense"), run(rt, "STARTER_EXPENSE_CATEGORIES_").map((c) => c[0]));
  assert.deepEqual(catNames(rt, "income"), run(rt, "STARTER_INCOME_CATEGORIES_").map((c) => c[0]));
  assert.ok(catNames(rt, "investment").includes("Contribution") && catNames(rt, "transfer").includes("Between Accounts"), "the system categories are still there");
  const owner = freshApp({ small: true }).rt;
  assert.ok(catNames(owner, "expense").includes("Psychologist") && catNames(owner, "expense").includes("Credit card"), "the owner's long list is untouched");
});

test("a pick adds only its one category, in the person's language, and the answers are remembered", () => {
  const rt = friendCopy();
  const res = post(rt, "applyProfile", { answers: ["selfemployed", "car", "nonsense", "invest"] }, "es").data;
  assert.deepEqual(res.profile, ["car", "selfemployed"], "unknown and retired answers are ignored, the rest keep the app's order");
  assert.deepEqual(res.added.map((a) => a.name), ["Vehículo", "Gastos de trabajo"]);
  assert.ok(catNames(rt, "expense").includes("Vehicle") && catNames(rt, "expense").includes("Work expenses"), "stored under the English names");
  assert.equal(rt.rows("Settings").find((s) => s.key === "profile").value, "car,selfemployed");
  const meta = post(rt, "getMeta", {}, "es").data;
  assert.ok(meta.categories.some((c) => c.name === "Mascotas") === false, "nothing else was added");
  assert.ok(meta.categories.some((c) => c.name === "Vehículo"), "shown in Spanish");
  assert.equal(meta.settings.profile, "car,selfemployed", "the app can see the answers");
});

test("every answer together adds 15 categories; running it again adds nothing", () => {
  const rt = friendCopy();
  const all = run(rt, "PROFILE_ORDER_");
  const first = post(rt, "applyProfile", { answers: all }).data;
  assert.equal(first.added.length, 15);
  const before = rt.rows("Categories").length;
  const again = post(rt, "applyProfile", { answers: all }).data;
  assert.equal(again.added.length, 0);
  assert.equal(rt.rows("Categories").length, before);
  assert.equal(new Set(catNames(rt, "expense")).size, catNames(rt, "expense").length, "no duplicate names");
  assert.ok(["Education", "Shopping", "Entertainment", "Going out", "Hobbies", "Subscriptions"].every((n) => catNames(rt, "expense").includes(n)));
});

test("people who already use the app: nothing they have is duplicated, changed or removed; the gaps are filled", () => {
  const { rt } = freshApp({ small: true });
  const before = rt.rows("Categories").map((c) => `${c.type}:${c.name}`);
  const res = post(rt, "applyProfile", { answers: run(rt, "PROFILE_ORDER_"), basics: true }).data;
  const added = res.added.map((a) => a.name);
  for (const covered of ["Vehicle", "Health", "Work expenses", "Family support", "Going out", "Personal care", "Gifts & donations", "Education", "Shopping", "Groceries", "Salary"]) {
    assert.ok(!added.includes(covered), `${covered} is covered by what the copy already has`);
  }
  for (const gap of ["Kids", "Pets", "Interest", "Subscriptions", "Hobbies"]) assert.ok(added.includes(gap), `${gap} is a gap`);
  const after = rt.rows("Categories").map((c) => `${c.type}:${c.name}`);
  for (const b of before) assert.ok(after.includes(b), `${b} is still there`);
  assert.equal(after.length, before.length + added.length);
  assert.equal(new Set(after).size, after.length, "no duplicate names");
});

test("the insurance e-mail rule falls back to Insurance on a copy that has no 'Credit card' category", () => {
  const { rt } = freshApp({ small: true });
  const guess = (names) => run(rt, `guessCategoryForEmail_({ type: 'expense', merchant: 'Crecer Seguros', defaultCategory: 'Credit card', defaultCategoryAlt: 'Insurance' }, '2026-10-01', { expenseCatIdByName: ${JSON.stringify(names)}, transferCatId: 't' })`);
  assert.equal(guess({ "Credit card": "cc", Insurance: "ins" }).categoryId, "cc", "the owner's copy still files it as before");
  assert.equal(guess({ Insurance: "ins" }).categoryId, "ins", "a copy that has an Insurance category files it there");
  const src = doc("backend", "EmailParser.gs");
  assert.match(src, /defaultCategory: 'Credit card', defaultCategoryAlt: 'Insurance'/);
});

test("a backend that can do it says so in its capabilities", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(post(rt, "getMeta", {}).data.capabilities.profile, true);
});

test("the welcome has the 'What fits you?' screen with two groups; the Business question stays on it, hidden unless the pack is offered", () => {
  const html = doc("docs", "index.html");
  const app = doc("docs", "app.js");
  const fits = html.indexOf('<div id="welcome-fits" hidden>');
  const accounts = html.indexOf('<div id="welcome-accounts" hidden>');
  const wb = html.indexOf('<div id="wb-block" hidden>');
  assert.ok(fits > 0 && fits < wb && wb < accounts, "the Business question sits on the new screen, hidden by default");
  assert.match(app, /waEl_\("wb-block"\)\.hidden = !businessOffered\(\)/, "and is shown only where the pack is offered");
  assert.match(app, /function waNext_\(\) \{[\s\S]*?showWelcomeStep_\(4\);\s*\n\}/, "the accounts step leads to the platforms step for everyone");
  assert.match(app, /welcome_\.fits\.length && meta && meta\.capabilities && meta\.capabilities\.profile/, "an older backend is never asked");
  assert.match(app, /categories-suggest-btn"\)\.hidden = !\(meta && meta\.capabilities && meta\.capabilities\.profile\)/);
  assert.match(app, /FITS_GROUPS_ = \[\s*\{ title: "fits\.g\.life"[\s\S]*"fits\.g\.spheres"/);
  assert.match(doc("docs", "strings.js"), /"welcome\.step": \{ en: "Step \{n\} of 4"/);
});
