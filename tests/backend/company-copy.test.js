// Business 2, piece 1: the COMPANY COPY (a copy the owner marks for one company) and its welcome by sector (backend/CompanyCopy.gs).
// Made-up data only, on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const post = (rt, action, payload = {}, lang) => (rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) })));

// A new person's copy as the installer builds it (FEATURES present, the starter categories), optionally marked as a company copy.
function friendCopy(mark) {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  if (mark === "setting") rt.run("setSetting_('company_copy', 'yes')");
  if (mark === "property") rt.svc.props.set("COMPANY_COPY", "yes");
  return rt;
}
const visible = (rt, type) => rt.rows("Categories").filter((c) => c.type === type && c.hidden !== "yes").map((c) => c.name);

test("only a copy the owner marked is a company copy; the owner's own copy never is, whatever a row says", () => {
  const plain = friendCopy();
  assert.equal(plain.api("getMeta", {}).capabilities.companyCopy, false);
  assert.equal(plain.api("getMeta", {}).capabilities.businessOffered, false, "a plain friend's copy still does not see the pack");

  const owner = freshApp({ small: true }).rt;
  owner.run("setSetting_('company_copy', 'yes')");
  owner.svc.props.set("COMPANY_COPY", "yes");
  assert.equal(owner.api("getMeta", {}).capabilities.companyCopy, false);
  assert.throws(() => owner.api("saveCompanySetup", { sector: "construction", name: "Acme" }), /company's copy/i);

  for (const mark of ["setting", "property"]) {
    const rt = friendCopy(mark);
    const caps = rt.api("getMeta", {}).capabilities;
    assert.equal(caps.companyCopy, true, mark);
    assert.equal(caps.businessOffered, true, mark);
    assert.equal(caps.business, true, `${mark}: the pack is on from the start`);
    assert.equal(caps.onboarding, true, `${mark}: it is still a new person's copy with its welcome`);
  }
});

test("a company copy built with the property carries the Settings row from the start; a plain copy never gets it", () => {
  const rt = friendCopy("property");
  rt.sheet("Settings").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedSettings();");
  assert.equal(rt.rows("Settings").find((r) => r.key === "company_copy").value, "yes");
  const plain = friendCopy();
  plain.sheet("Settings").rows.length = 1;
  plain.run("ROWS_MEMO_ = null; seedSettings();");
  assert.equal(plain.rows("Settings").find((r) => r.key === "company_copy"), undefined);
});

test("a company copy has the pack always on: it cannot be turned off, and an old 'no' in Settings is ignored", () => {
  const rt = friendCopy("setting");
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  assert.throws(() => rt.api("setBusinessFeatures", { on: false }), /always on|siempre están activadas/);
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  rt.run("setSetting_('business_features', 'no')");   // a copy that had turned it off before this rule
  assert.equal(rt.api("getMeta", {}).capabilities.business, true);
  // the phone shows no switch there (My profile → What fits me)
  const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(app, /"bf-block"\)\.hidden = !businessOffered\(\) \|\| !!\(meta && meta\.capabilities && meta\.capabilities\.companyCopy\)/);
});

test("the welcome's company step: the company with its sector, its projects and the construction categories, in one call", () => {
  const rt = friendCopy("setting");
  const out = rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte", " ", "Otros proyectos", "obra norte"] });
  const companies = rt.rows("Companies");
  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, "Constructora Andina");
  assert.equal(companies[0].sector, "construction", "the sector is kept on the company, not on the copy");
  assert.deepEqual(rt.rows("Projects").map((p) => [p.name, p.company_id, p.status]),
    [["Obra Norte", companies[0].id, "active"], ["Otros proyectos", companies[0].id, "active"]], "blank and repeated names are dropped");
  assert.equal(out.projects.length, 2);

  const exp = visible(rt, "expense"), inc = visible(rt, "income");
  for (const n of ["Materials", "Labor", "Design & permits", "Notary & registries", "Loan interest", "Bank fees", "Other"]) assert.ok(exp.includes(n), n);
  for (const n of ["Reservation deposits", "Down payments", "Sale balances", "Other"]) assert.ok(inc.includes(n), n);
  for (const n of ["Groceries", "Restaurants", "Home", "Transport", "Travel"]) assert.ok(!exp.includes(n), `${n} is hidden`);
  for (const n of ["Salary", "Business", "Gifts"]) assert.ok(!inc.includes(n), `${n} is hidden`);
  assert.ok(inc.includes("Refunds"), "the categories the app depends on stay");
  assert.equal(rt.rows("Categories").filter((c) => c.name === "Groceries").length, 1, "hidden, never deleted");
  assert.equal(rt.rows("Categories").filter((c) => c.name === "Bank fees" && c.type === "expense").length, 1, "Bank fees is not made twice");

  const all = rt.rows("Categories").map((c) => c.name.toLowerCase());
  assert.ok(!all.some((n) => /contribution|aporte|loan$|préstamo/.test(n) && n !== "contribution"),
    "no contribution or loan INCOME/EXPENSE category: they move balances, never income or an expense");
  assert.ok(!rt.rows("Categories").some((c) => c.name === "Contribution" && c.type !== "investment"));
});

test("Spanish names of the construction categories", () => {
  const rt = friendCopy("setting");
  rt.api("saveCompanySetup", { sector: "construction", name: "Acme" });
  const meta = post(rt, "getMeta", {}, "es");
  const names = (meta.data || meta).categories.filter((c) => c.hidden !== "yes").map((c) => c.name);
  for (const n of ["Materiales", "Mano de obra", "Diseño y licencias", "Notaría y registros", "Intereses de préstamos", "Comisiones bancarias", "Otros",
    "Separaciones", "Cuotas iniciales", "Saldos de venta"]) assert.ok(names.includes(n), n);
});

test("sending it again (a lost reply) never doubles anything; a category already used is never hidden", () => {
  const rt = friendCopy("setting");
  const groceries = rt.rows("Categories").find((c) => c.name === "Groceries");
  rt.run(`appendRowObject('Entries', { id: 'e-used', type: 'expense', date: '2026-11-01', amount: 10, currency: 'PEN', category_id: '${groceries.id}', status: 'confirmed' })`);
  rt.run("ROWS_MEMO_ = null");
  rt.api("saveCompanySetup", { sector: "construction", name: "Acme", projects: ["P1"] });
  rt.api("saveCompanySetup", { sector: "construction", name: "acme ", projects: ["P1", "P2"] });
  assert.equal(rt.rows("Companies").length, 1);
  assert.deepEqual(rt.rows("Projects").map((p) => p.name), ["P1", "P2"]);
  assert.equal(rt.rows("Categories").filter((c) => c.name === "Materials").length, 1);
  assert.ok(visible(rt, "expense").includes("Groceries"), "used by an entry: stays visible");
});

test("the other sector: general business categories; Transport is kept because the sector uses it", () => {
  const rt = friendCopy("setting");
  rt.api("saveCompanySetup", { sector: "other", name: "Acme" });
  const exp = visible(rt, "expense"), inc = visible(rt, "income");
  for (const n of ["Supplies", "Salaries & fees", "Rent", "Services & utilities", "Transport", "Loan interest", "Bank fees", "Other"]) assert.ok(exp.includes(n), n);
  for (const n of ["Sales", "Services provided", "Other"]) assert.ok(inc.includes(n), n);
  assert.equal(rt.rows("Companies")[0].sector, "other");
});

test("the checks: a sector and a name are needed", () => {
  const rt = friendCopy("setting");
  assert.throws(() => rt.api("saveCompanySetup", { sector: "bakery", name: "Acme" }), /what your company does/i);
  assert.throws(() => rt.api("saveCompanySetup", { sector: "construction", name: "  " }), /company's name/i);
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Companies')`) || rt.rows("Companies").length === 0);
});

test("every sector pack name has a Spanish name, and every sector has its texts on the phone in both languages", () => {
  const rt = freshApp({ small: true }).rt;
  const packs = run(rt, "SECTOR_PACKS_"), order = run(rt, "SECTOR_ORDER_");
  const tr = run(rt, "CATEGORY_TRANSLATIONS_");
  assert.deepEqual(Object.keys(packs).sort(), order.slice().sort());
  assert.equal(order[order.length - 1], "other", "Other is last");
  for (const s of order) {
    for (const type of ["expense", "income"]) {
      for (const [name, icon] of packs[s][type]) {
        assert.ok(icon, name);
        const key = rt.run(`categoryKeyFromName_(${JSON.stringify(name)})`);
        assert.ok(tr[key] && tr[key].es && tr[key].en === name, `${name} has a Spanish name`);
      }
    }
  }
  const strings = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");
  for (const s of order) assert.match(strings, new RegExp(`"sector\\.${s}": \\{ en: "[^"]+", es: "[^"]+"`), s);
});

// ---- The company invitation (docs/company-invite.js): a code from the person's Google e-mail, checked by the install page ----
const INVITE = fs.readFileSync(path.join(__dirname, "../../docs/company-invite.js"), "utf8");
function inviteLib() {
  const sandbox = { crypto: require("node:crypto").webcrypto, TextEncoder, Uint8Array };
  sandbox.globalThis = sandbox;
  require("node:vm").runInNewContext(INVITE, sandbox);
  return sandbox.CompanyInvite;
}

test("the invitation code: one per e-mail, the same every time, case and spaces ignored, easy to read", async () => {
  const ci = inviteLib();
  const a = await ci.code("persona.ejemplo@example.com");
  assert.match(a, /^EM-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(await ci.code("  Persona.Ejemplo@Example.com "), a);
  assert.notEqual(await ci.code("otra.persona@example.com"), a);
  assert.equal(await ci.matches(a.toLowerCase().replace(/-/g, " "), "persona.ejemplo@example.com"), true);
  assert.equal(await ci.matches(a, "otra.persona@example.com"), false, "a code only works with its own Google account");
  assert.equal(await ci.matches(a, ""), false, "no account known: never a company copy");
  assert.equal(ci.fromAddress({ hash: "#company=" + a, search: "" }), a);
  assert.equal(ci.fromAddress({ hash: "", search: "" }), "");
});

test("the installer marks the copy only when the install page says the code matched; an update never unmarks it", () => {
  const INSTALL = fs.readFileSync(path.join(__dirname, "../../docs/setup/Install.gs"), "utf8");
  const load = (rt, company, release) => rt.run(INSTALL.replace("__COMPANY__", company).replace("__RELEASE__", release)
    .replace("__CODE__", "made-up-code-0123456789abcdef").replace("__MAINURL__", "").replace("__FEATURES__", "base"));
  const rt = freshApp({ small: true }).rt;
  load(rt, "", "r1");
  rt.run("installApplyCode_()");
  assert.equal(rt.svc.props.get("COMPANY_COPY") || null, null, "a plain install is not a company copy");
  const co = freshApp({ small: true }).rt;
  load(co, "yes", "r1");
  co.run("installApplyCode_()");
  assert.equal(co.svc.props.get("COMPANY_COPY"), "yes");
  assert.equal(co.run("isCompanyCopy_()"), true);
  load(co, "", "r2");   // "Update my app": no invitation in the link
  co.run("installApplyCode_()");
  assert.equal(co.svc.props.get("COMPANY_COPY"), "yes");
});

test("the install page fills the mark from the invitation and loads the shared recipe; the app's card is the owner's only", () => {
  const setup = fs.readFileSync(path.join(__dirname, "../../docs/setup/index.html"), "utf8");
  assert.match(setup, /<script src="\.\.\/company-invite\.js"><\/script>/);
  assert.match(setup, /\.replace\('__COMPANY__', company\)/);
  assert.match(setup, /CompanyInvite\.matches\(WANT_COMPANY, state\.account\)/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  assert.match(html, /<div id="business-invite" class="business-invite" hidden>/);
  assert.match(html, /<script src="company-invite\.js\?v=[^"]+"><\/script>\s*<script src="app\.js/);
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /getElementById\("business-invite"\)\.hidden = !perfIsOwnerCopy_\(\)/);
});
