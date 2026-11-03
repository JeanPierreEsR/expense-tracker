// Screen headers with Edit mode use round icon buttons (owner's request 2026-11-02): a pencil for Edit, a "+" for Add, the same outlined circle
// as the period arrows. Each has a spoken name in both languages, and each edit bar has a plain Done button.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js"), css = docs("style.css");

const button = (id) => new RegExp(`<button[^>]*id="${id}"[^>]*>[\\s\\S]*?</button>`).exec(html)[0];

test("Edit is a pencil icon and Add is a + icon on Friends, Programmed items and Budgets, with no text label", () => {
  for (const id of ["friends-edit-btn", "recurring-edit-btn", "budgets-edit-btn", "friends-add-btn", "add-recurring-btn", "add-budget-btn"]) {
    const b = button(id);
    assert.match(b, /class="icon-btn"/, id);
    assert.match(b, /<svg/, id + " draws its own icon");
    assert.match(b, /aria-label="[^"]+"/, id + " has a spoken name");
    assert.ok(!/data-i18n="/.test(b), id + " has no text that would replace the icon");
  }
});

test("the spoken names exist in both languages, and the tip texts no longer name a text button", () => {
  for (const key of ["budgets.addAria", "friends.addAria", "recurring.addAria", "friends.edit", "friends.done"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key);
  }
  assert.match(strings, /"spot\.b\.s1": \{ en: "Tap the \+ button\."/);
  assert.match(strings, /"spot\.r\.s1": \{ en: "Tap the \+ button\."/);
});

test("the pencil is filled while Edit is on (not relabelled), and every edit bar has a Done button wired up", () => {
  assert.match(app, /function setEditIcon_\(btn, on\)/);
  assert.ok(!/"(friends|recurring|budgets)-edit-btn"\)\.textContent/.test(app), "no code writes text into a pencil");
  for (const pre of ["friends", "recurring", "budgets"]) {
    assert.match(html, new RegExp(`id="${pre}-done-btn"`));
    assert.match(app, new RegExp(`getElementById\\("${pre}-done-btn"\\)\\.addEventListener`));
  }
  assert.match(css, /\.icon-btn\.on \{/);
});

test("every other screen or card header Add button (sweep of 2026-11-02) is a + icon too, with a spoken name in both languages", () => {
  const ids = { "add-balance-btn": "balances.addAria", "add-loan-btn": "loans.addAria", "accounts-add-btn": "accounts.addAria", "categories-add-btn": "categories.addAria",
    "trips-add-btn": "trips.addAria", "business-add-company-btn": "business.addCompanyAria", "people-add-btn": "people.addPersonAria", "igv-add-payment-btn": "igv.addPaymentAria" };
  for (const [id, key] of Object.entries(ids)) {
    const b = button(id);
    assert.match(b, /class="icon-btn"/, id);
    assert.match(b, /<svg/, id);
    assert.ok(b.includes(`data-i18n-aria-label="${key}"`), id + " is named by " + key);
    assert.ok(!/data-i18n="/.test(b), id + " has no text");
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key);
  }
});

test("no text still tells the person to tap a '+ Add' header button that no longer exists", () => {
  assert.ok(!/[Tt]ap \+ Add(\.|,| loan| budget| balance| to )|[Tt]oca \+ Agregar(\.|,| préstamo| presupuesto| saldo| para )/.test(strings));   // ("+ Add friend…" / "+ Agregar ítem" are buttons inside forms and stay)
});
