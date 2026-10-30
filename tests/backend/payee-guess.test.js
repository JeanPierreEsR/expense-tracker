// "Same place, same treatment" (PayeeGuess.gs): a waiting e-mail entry to a place the person has always filed the same way
// arrives that way; a loan habit is only a suggestion. Made-up names and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, BCP_SENDER } = require("./helpers");

const email = (rt, { to, amount = "300.00", op }) => rt.svc.gmail.addEmail({
  from: BCP_SENDER,
  subject: "Constancia de Transferencia a Otros Bancos - Servicio de Notificaciones BCP",
  daysAgo: 0,
  body: [
    "Hola *Eva Carla,*", "", "Realizaste una transferencia de *S/ " + amount + "* desde tu *Clasica.*", "",
    "*Montos*", "", "Monto enviado *S/ " + amount + "* ", "Comisión *S/ 0.00* ", "*Total cobrado* *S/ " + amount + "* ", "",
    "*Datos de la operación*", "", "Operación realizada *Transferencia a otros bancos* ",
    "Enviado a *" + to + "*", "**** 4044 ", "Banco destino *Interbank* ", "Moneda *Soles* ", "Tipo de envío *Inmediato* ",
    "Desde *Clasica*", "**** 0005 ", "Canal *Banca Móvil BCP* ", "Número de operación *" + op + "* <#> "
  ].join("\n")
});
const run = (rt) => rt.run("processEmails()");
const pendingOf = (rt, op) => rt.rows("Entries").find((e) => e.source === "email" && e.status === "pending" && e.external_id === op);
let n = 0;
function history(rt, over) {
  const e = { id: "ph" + ++n, type: "expense", date: today(), amount: 100, currency: "PEN", category_id: "", description: "Broker Xyz",
    merchant: "broker xyz", paid_by: "me", status: "confirmed", source: "email", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
function setup() {
  const { rt, data } = freshApp({ small: true });
  rt.run(`ensureEntriesMerchantColumn_(); ensureEntriesToPaymentMethodColumn_();`);
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  rt.run(`appendRowObject('Payment Methods', { id: 'plat-1', nickname: 'Test Platform', type: 'investment', bank_id: '', last_4: '' });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'plat-2', nickname: 'Other Platform', type: 'investment', bank_id: '', last_4: '' });`);
  const expenseCat = data.cats.find((c) => c.type === "expense");
  return { rt, data, expenseCat };
}
const invest = (rt, platform = "plat-1") => history(rt, { type: "investment", to_payment_method_id: platform, category_id: "" });

test("three investment deposits to the same place: the next e-mail arrives as an investment with that platform, still waiting", () => {
  const { rt } = setup();
  invest(rt); invest(rt); invest(rt);
  email(rt, { to: "Broker XYZ", op: "PG-1" });
  run(rt);
  const e = pendingOf(rt, "PG-1");
  assert.ok(e);
  assert.equal(e.type, "investment");
  assert.equal(e.to_payment_method_id, "plat-1");
  assert.equal(e.status, "pending");
  assert.equal(Number(e.amount), 300);
  assert.equal(e.merchant, "broker xyz");
});

test("two earlier deposits are not enough, and neither is a split history", () => {
  const { rt } = setup();
  invest(rt); invest(rt);
  email(rt, { to: "Broker XYZ", op: "PG-2" });
  run(rt);
  assert.equal(pendingOf(rt, "PG-2").type, "expense");

  const other = setup();
  invest(other.rt); invest(other.rt, "plat-2"); history(other.rt, { type: "expense", category_id: other.expenseCat.id });
  email(other.rt, { to: "Broker XYZ", op: "PG-3" });
  run(other.rt);
  assert.equal(pendingOf(other.rt, "PG-3").type, "expense");
});

test("a place always filed under one category gets that category, as an expense", () => {
  const { rt, expenseCat } = setup();
  for (let i = 0; i < 3; i++) history(rt, { type: "expense", category_id: expenseCat.id });
  email(rt, { to: "Broker XYZ", op: "PG-4" });
  run(rt);
  const e = pendingOf(rt, "PG-4");
  assert.equal(e.type, "expense");
  assert.equal(e.category_id, expenseCat.id);
});

test("only confirmed history counts, and the e-mail's own name (not a renamed description) is the key", () => {
  const { rt } = setup();
  for (let i = 0; i < 3; i++) history(rt, { type: "investment", to_payment_method_id: "plat-1", status: "pending" });
  email(rt, { to: "Broker XYZ", op: "PG-5" });
  run(rt);
  assert.equal(pendingOf(rt, "PG-5").type, "expense", "waiting entries never teach");

  const r2 = setup();
  for (let i = 0; i < 3; i++) history(r2.rt, { type: "investment", to_payment_method_id: "plat-1", description: "My savings", merchant: "broker xyz" });
  email(r2.rt, { to: "Broker XYZ", op: "PG-6" });
  run(r2.rt);
  assert.equal(pendingOf(r2.rt, "PG-6").type, "investment");
});

test("a platform that no longer exists is not guessed", () => {
  const { rt } = setup();
  invest(rt, "gone"); invest(rt, "gone"); invest(rt, "gone");
  email(rt, { to: "Broker XYZ", op: "PG-7" });
  run(rt);
  assert.equal(pendingOf(rt, "PG-7").type, "expense");
});

test("a place turned into a loan three times shows a suggestion on the waiting entry, and changes nothing", () => {
  const { rt, data } = setup();
  const friend = data.friends[0];
  for (let i = 0; i < 3; i++) {
    rt.run(`ensurePayeeHabitsSheet_(); appendRowObject('Payee Habits', { key: 'broker xyz', kind: 'loan', friend_id: '${friend.id}', direction: 'they_owe_me', created_at: 'x' });`);
  }
  email(rt, { to: "Broker XYZ", op: "PG-8" });
  run(rt);
  assert.equal(pendingOf(rt, "PG-8").type, "expense");
  const listed = rt.api("listPendingEntries", {}).find((e) => e.external_id === "PG-8");
  assert.ok(listed.loan_hint);
  assert.equal(listed.loan_hint.kind, "loan");
  assert.equal(listed.loan_hint.friend_id, friend.id);
  assert.equal(listed.loan_hint.direction, "they_owe_me");
});

test("converting a waiting entry into a loan is remembered for next time", () => {
  const { rt, data } = setup();
  email(rt, { to: "Ana Test", op: "PG-9" });
  run(rt);
  const e = pendingOf(rt, "PG-9");
  rt.api("convertEntryToLoan", { entry_id: e.id, friend_id: data.friends[0].id, direction: "they_owe_me", amount: 300, currency: "PEN", date: today(), payment_method_id: e.payment_method_id });
  const habits = rt.rows("Payee Habits");
  assert.equal(habits.length, 1);
  assert.equal(habits[0].key, "ana test");
  assert.equal(habits[0].kind, "loan");
});

test("the new-entry form asks by description: investment, or nothing", () => {
  const { rt } = setup();
  invest(rt); invest(rt); invest(rt);
  const hit = rt.api("suggestForDescription", { description: "  BROKER xyz " });
  assert.equal(hit.type, "investment");
  assert.equal(hit.to_payment_method_id, "plat-1");
  assert.ok(hit.reason);
  assert.deepEqual(rt.api("suggestForDescription", { description: "something new" }), {});
  assert.deepEqual(rt.api("suggestForDescription", { description: "" }), {});
});
