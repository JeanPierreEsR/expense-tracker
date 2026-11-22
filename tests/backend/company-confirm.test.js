// Business 2, piece 2: on a company copy with ONE company, every expense or income belongs to it, from whatever source,
// when it is made and again when it is confirmed (backend/CompanyCopy.gs). Made-up data only, on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram, bcpEmail } = require("./helpers");

// A new person's copy as the installer builds it; `company` = marked as a company copy and through its welcome.
function copy({ company = true, companies = 1 } = {}) {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  if (company) {
    rt.run("setSetting_('company_copy', 'yes')");
    rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
    for (let i = 1; i < companies; i++) rt.api("addCompany", { name: "Segunda SAC" });
  }
  return rt;
}
const companyId = (rt) => (rt.rows("Companies")[0] || {}).id;
const entry = (rt, id) => rt.rows("Entries").find((e) => e.id === id);
const cat = (rt, type) => rt.rows("Categories").find((c) => c.type === type && c.hidden !== "yes").id;
const addBcpCard = (rt) => rt.run(`(function () { var b = getAllRows('Banks').find(function (x) { return x.name === 'BCP'; });
  var pm = { id: 'pm-co-test', nickname: 'Test BCP debit', type: 'debit', bank_id: b.id, last_4: '1234' };
  appendRowObject('Payment Methods', pm); return pm.id; })()`);
// A waiting entry written the way the automatic sources write it (no company at all), straight into the sheet.
function waiting(rt, fields = {}) {
  const id = "w-" + Math.random().toString(36).slice(2);
  rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date: today(), amount: 40, currency: "PEN",
    category_id: cat(rt, fields.type || "expense"), description: "Ferretería", payment_method_id: "", paid_by: "me", status: "pending", source: "email" }, fields))})`);
  return id;
}

test("a bank e-mail on a company copy waits in Needs review already on the company, and Confirm keeps it there", () => {
  const rt = copy();
  addBcpCard(rt);
  bcpEmail(rt, { amount: "25.50", merchant: "FERRETERIA CENTRAL", op: "445001" });
  rt.run("processEmails()");
  const e = rt.rows("Entries").find((x) => x.source === "email" && /ferreteria/i.test(x.description || ""));
  assert.ok(e, "the e-mail became an entry");
  assert.equal(e.status, "pending", "automatic: still waits for the person");
  assert.equal(e.company_id, companyId(rt));
  assert.equal(e.project_id, "");
  rt.api("updateEntry", { id: e.id, fields: { category_id: cat(rt, "expense") } });
  rt.api("confirmEntry", { id: e.id });
  assert.equal(entry(rt, e.id).status, "confirmed");
  assert.equal(entry(rt, e.id).company_id, companyId(rt));
});

test("it counts for the company in Overview once confirmed, never while it waits", () => {
  const rt = copy();
  const id = waiting(rt, { amount: 75 });
  const scope = "company:" + companyId(rt);
  const spent = () => rt.api("getPeriodSummary", { start: today(), end: today(), scope }).totals.expense;
  assert.equal(Number(spent() || 0), 0, "a waiting entry counts nowhere");
  rt.api("confirmEntry", { id });
  assert.equal(Number(spent()), 75);
});

test("every way of confirming gives the company: one, several, the full form, Telegram", () => {
  const rt = copy();
  const cid = companyId(rt);
  // Written before the company existed (or by an older backend): no company on the row yet.
  const bare = () => { const id = waiting(rt); rt.run(`setEntryField_(${JSON.stringify(id)}, 'company_id', '')`); assert.equal(entry(rt, id).company_id, ""); return id; };
  const one = bare(); rt.api("confirmEntry", { id: one });
  const a = bare(), b = bare(); rt.api("confirmEntries", { items: [{ id: a }, { id: b }] });
  const form = bare(); rt.api("saveEntryAll", { kind: "confirm", id: form, fields: { description: "Cemento" } });
  const tg = bare(); const chat = linkTelegram(rt);
  rt.rawPost(JSON.stringify({ update_id: 9101, callback_query: { id: "cb1", data: "confirm:" + tg, message: { chat: { id: chat }, message_id: 77 } } }));
  for (const id of [one, a, b, form, tg]) {
    assert.equal(entry(rt, id).status, "confirmed", id);
    assert.equal(entry(rt, id).company_id, cid, id);
  }
});

test("a project chosen on the card, and 'Personal' chosen on purpose, are kept", () => {
  const rt = copy();
  const project = rt.rows("Projects")[0];
  const p = waiting(rt);
  rt.api("saveEntryAll", { kind: "confirm", id: p, fields: { project_id: project.id, company_id: project.company_id } });
  assert.equal(entry(rt, p).project_id, project.id);
  assert.equal(entry(rt, p).company_id, companyId(rt));
  const mine = waiting(rt);
  rt.api("saveEntryAll", { kind: "confirm", id: mine, fields: { project_id: "", company_id: "" } });
  assert.equal(entry(rt, mine).status, "confirmed");
  assert.equal(entry(rt, mine).company_id, "", "Personal on the card stays personal");
  const mine2 = waiting(rt);
  rt.api("updateEntry", { id: mine2, fields: { project_id: "", company_id: "" } });
  rt.api("confirmEntry", { id: mine2, personal: true });
  assert.equal(entry(rt, mine2).company_id, "");
});

test("the '+' form: no company sent = the company; 'Personal' sent = personal", () => {
  const rt = copy();
  const base = { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: cat(rt, "expense"), description: "Clavos", paid_by: "me" };
  const made = rt.api("createEntry", base);
  assert.equal(entry(rt, made.id).company_id, companyId(rt));
  const mine = rt.api("createEntry", Object.assign({}, base, { project_id: "", company_id: "" }));
  assert.equal(entry(rt, mine.id).company_id, "");
  const inc = rt.api("createEntry", { type: "income", date: today(), amount: 900, currency: "PEN", category_id: cat(rt, "income"), description: "Separación lote 4" });
  assert.equal(entry(rt, inc.id).company_id, companyId(rt));
});

test("transfers and investments never belong to a company; friend money stays personal", () => {
  const rt = copy();
  const pms = rt.rows("Payment Methods");
  const t = waiting(rt, { type: "transfer", category_id: "", payment_method_id: pms[0] ? pms[0].id : "" });
  assert.equal(entry(rt, t).company_id || "", "");
  const i = waiting(rt, { type: "investment", category_id: "" });
  assert.equal(entry(rt, i).company_id || "", "");
  rt.run(`companyDefaultOnConfirm_(getEntryById_(${JSON.stringify(t)}), false)`);
  assert.equal(entry(rt, t).company_id || "", "");
  const friend = rt.api("addFriend", { name: "Amigo Prueba" });
  const over = rt.api("recordOverpaymentIncome", { friend_id: friend.id, amount: 5, date: today(), category_id: cat(rt, "income") });
  assert.equal(entry(rt, over.id).company_id, "");
});

test("statements: the rows a statement adds get the company too", () => {
  const rt = copy();
  rt.run(`appendRowsBulk_('Entries', [{ id: 's1', type: 'expense', date: '${today()}', amount: 9, currency: 'PEN', status: 'confirmed', source: 'import' },
    { id: 's2', type: 'transfer', date: '${today()}', amount: 9, currency: 'PEN', status: 'confirmed', source: 'import' }])`);
  assert.equal(entry(rt, "s1").company_id, companyId(rt));
  assert.equal(entry(rt, "s2").company_id, "");
});

test("two companies: nothing is guessed", () => {
  const rt = copy({ companies: 2 });
  assert.equal(rt.rows("Companies").length, 2);
  const id = waiting(rt);
  assert.equal(entry(rt, id).company_id, "");
  rt.api("confirmEntry", { id });
  assert.equal(entry(rt, id).company_id, "");
});

test("a normal copy stays personal: friends' copies and the owner's own", () => {
  for (const rt of [copy({ company: false }), freshApp({ small: true }).rt]) {
    const id = waiting(rt);
    rt.api("confirmEntry", { id });
    assert.equal(entry(rt, id).company_id || "", "");
    const made = rt.api("createEntry", { type: "expense", date: today(), amount: 3, currency: "PEN", category_id: cat(rt, "expense"), description: "Café", paid_by: "me" });
    assert.equal(entry(rt, made.id).company_id || "", "");
  }
  // The owner's copy with ONE company of his own: still personal unless he picks it (it is not a company copy).
  const owner = freshApp({ small: true }).rt;
  owner.api("setBusinessFeatures", { on: true });
  owner.api("addCompany", { name: "Estudio Prueba" });
  const keep = owner.rows("Companies").length;
  const id = waiting(owner);
  owner.api("confirmEntry", { id });
  assert.equal(entry(owner, id).company_id || "", "", `owner with ${keep} company(ies)`);
});

test("the phone: the '+' form and the Needs review card know the company copy's company", () => {
  const fs = require("node:fs"), path = require("node:path");
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /function companyDefaultPick_\(\)[\s\S]{0,300}capabilities\.companyCopy/);
  assert.match(app, /class="review-business"/);
  assert.match(app, /"\.review-business"/, "a box being changed survives a redraw");
  assert.match(app, /let businessAutoPick_/);
});
