// More → Categories: create with emoji + color, change, refuse duplicates, delete an unused one,
// refuse (with a count) one in use, and hide / show instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

test("a new category keeps its emoji and color, has no key, and shows up in getMeta", () => {
  const { rt } = freshApp({ entries: 50 });
  const res = post(rt, "saveCategory", { type: "expense", name: "  Pet   care ", icon: "🐶", color: "#C9E4F7" });
  assert.ok(res.data && res.data.id, JSON.stringify(res));
  const row = rt.rows("Categories").find((c) => c.id === res.data.id);
  assert.equal(row.name, "Pet care");
  assert.equal(row.icon, "🐶");
  assert.equal(row.color, "#C9E4F7");
  assert.equal(row.type, "expense");
  assert.ok(!row.key && !row.parent_id);
  const meta = post(rt, "getMeta").data;
  assert.ok(meta.categories.some((c) => c.id === res.data.id && c.name === "Pet care"));
});

test("a missing emoji or color gets a default; a letter instead of an emoji and a bad color are refused", () => {
  const { rt } = freshApp({ entries: 50 });
  const ok = post(rt, "saveCategory", { type: "income", name: "Side gigs" }).data;
  const row = rt.rows("Categories").find((c) => c.id === ok.id);
  assert.ok(row.icon);
  assert.match(row.color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: "Letters", icon: "ab" })), /emoji/);
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: "Bad color", color: "red" })), /colors/);
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: "" })), /name/i);
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "transfer", name: "Nope" })), /Expense or Income/);
});

test("a name that already exists for that type is refused (any case, accents, either language), the other type is fine", () => {
  const { rt } = freshApp({ entries: 50 });
  post(rt, "saveCategory", { type: "expense", name: "Café" });
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: " cafe " })), /already have a category/);
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: "Restaurantes" })), /already have a category/, "Spanish name of a built-in");
  assert.match(JSON.stringify(post(rt, "saveCategory", { type: "expense", name: "Cafe" }, "es")), /Ya tienes una categoría/);
  assert.ok(post(rt, "saveCategory", { type: "income", name: "Café" }).data.id, "same name in the other type is allowed");
});

test("changing a category updates name, emoji, color — never its type — and keeps its own name allowed", () => {
  const { rt } = freshApp({ entries: 50 });
  const c = post(rt, "saveCategory", { type: "expense", name: "Padel", icon: "🏋️", color: "#FFE0B2" }).data;
  const res = post(rt, "saveCategory", { id: c.id, type: "income", name: "Padel", icon: "🤸", color: "#D9F2D9" });
  assert.ok(res.data, JSON.stringify(res));
  const row = rt.rows("Categories").find((r) => r.id === c.id);
  assert.equal(row.icon, "🤸");
  assert.equal(row.color, "#D9F2D9");
  assert.equal(row.type, "expense", "type stays");
  post(rt, "saveCategory", { id: c.id, name: "Padel & pool", icon: "🤸", color: "#D9F2D9" });
  assert.equal(rt.rows("Categories").find((r) => r.id === c.id).name, "Padel & pool");
});

test("renaming a built-in category keeps its key; leaving the shown (Spanish) name alone keeps the English one stored", () => {
  const { rt } = freshApp({ entries: 50 });
  const builtIn = rt.rows("Categories").find((c) => c.key === "restaurants");
  post(rt, "saveCategory", { id: builtIn.id, name: "Restaurantes", icon: "🍴", color: "#FFE0B2" }, "es");
  const row = rt.rows("Categories").find((c) => c.id === builtIn.id);
  assert.equal(row.name, builtIn.name, "stored English name unchanged");
  assert.equal(row.icon, "🍴");
});

test("an unused category is deleted, and gone from getMeta at once", () => {
  const { rt } = freshApp({ entries: 50 });
  const c = post(rt, "saveCategory", { type: "expense", name: "Throwaway" }).data;
  const res = post(rt, "deleteCategory", { id: c.id });
  assert.equal(res.data && res.data.deleted, true, JSON.stringify(res));
  assert.ok(!rt.rows("Categories").some((r) => r.id === c.id));
  assert.ok(!post(rt, "getMeta").data.categories.some((r) => r.id === c.id));
});

test("a category used by an entry or a budget is refused with a count, in both languages, and can be hidden instead", () => {
  const { rt } = freshApp({ entries: 50 });
  const c = post(rt, "saveCategory", { type: "expense", name: "Used one" }).data;
  rt.run(`appendRowObject('Entries', { id: 'e-cat-1', type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', category_id: ${JSON.stringify(c.id)}, description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual' });`);
  rt.run(`appendRowObject('Budgets', { id: 'b-cat-1', category_id: ${JSON.stringify(c.id)}, amount: 100, currency: 'PEN', period_type: 'monthly' });`);
  assert.match(JSON.stringify(post(rt, "deleteCategory", { id: c.id })), /2 records use it/);
  assert.match(JSON.stringify(post(rt, "deleteCategory", { id: c.id }, "es")), /2 registros la usan/);
  assert.ok(rt.rows("Categories").some((r) => r.id === c.id), "still there");

  const hid = post(rt, "setCategoryHidden", { id: c.id, hidden: true });
  assert.equal(hid.data.hidden, "yes", JSON.stringify(hid));
  assert.equal(post(rt, "getMeta").data.categories.find((r) => r.id === c.id).hidden, "yes");
  assert.equal(post(rt, "setCategoryHidden", { id: c.id, hidden: false }).data.hidden, "");
});

test("'Other' and non-expense/income categories can't be deleted or hidden", () => {
  const { rt } = freshApp({ entries: 50 });
  const other = rt.rows("Categories").find((c) => c.key === "other" && c.type === "expense");
  assert.match(JSON.stringify(post(rt, "deleteCategory", { id: other.id })), /built-in category can't be edited, hidden or deleted/);
  assert.match(JSON.stringify(post(rt, "setCategoryHidden", { id: other.id, hidden: true })), /built-in category can't be edited, hidden or deleted/);
  assert.match(JSON.stringify(post(rt, "deleteCategory", { id: "nope" })), /not found/);
});
