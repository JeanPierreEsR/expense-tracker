// The person's own name is learned from their statements and bank e-mails, never typed (backend/OwnerNames.gs). All names are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const names = (rt) => run(rt, "ownerNamesList_()");
const learn = (rt, found) => run(rt, `learnOwnNames_(${JSON.stringify(found)})`);

test("one document is not enough; a second account showing the same name confirms it, whatever the word order", () => {
  const { rt } = freshApp({ small: true });
  assert.deepEqual(learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }]), []);
  assert.deepEqual(names(rt), [], "a lone statement could be a joint or someone else's account");
  // The same name, printed given-name-first and without the second surname, on ANOTHER account.
  assert.deepEqual(learn(rt, [{ name: "EVA CARLA RAMOS", source: "stmt:2222" }]).sort(), ["EVA CARLA RAMOS", "RAMOS TORRES EVA CARLA"]);
  assert.equal(names(rt).length, 2);
});

test("the same document twice does not confirm anything", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }]);
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }]);
  assert.deepEqual(names(rt), []);
});

test("different people on two accounts are not merged", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }, { name: "LUNA VEGA PABLO", source: "stmt:2222" }]);
  assert.deepEqual(names(rt), []);
});

test("things that are not a full name are never learned", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "EVA", source: "a" }, { name: "EVA", source: "b" }, { name: "CUENTA 123 SOLES", source: "c" }, { name: "CUENTA 123 SOLES", source: "d" }]);
  assert.deepEqual(names(rt), []);
});

test("own-name matching: every word must be the person's, so a relative or another Eva is not them", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  const own = (t) => run(rt, `isOwnNameText_(${JSON.stringify(t)})`);
  assert.equal(own("EVA"), true);
  assert.equal(own("EVA CARLA"), true);
  assert.equal(own("RAMOS EVA"), true);
  assert.equal(own("EVA MARIA"), false);
  assert.equal(own("ANA RAMOS"), false);
  assert.equal(own("AB"), false, "too short to mean anything");
  const full = (t) => run(rt, `isOwnFullName_(${JSON.stringify(t)})`);
  assert.equal(full("Eva Carla Ramos Torres"), true);
  assert.equal(full("TORRES RAMOS EVA CARLA"), true);
  assert.equal(full("Ana Ramos Torres"), false, "shares the surnames only");
  assert.equal(full("Eva Ramos"), false, "not all of the name");
});

test("the e-mail rule uses the learned name: a transfer to yourself is a transfer, to a relative with your surname is not", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(run(rt, `isOwnAccount_('Eva Carla Ramos Torres')`), false, "nothing learned yet, nobody is 'me'");
  rt.run(`setSetting_('owner_names', 'Eva Carla Ramos Torres')`);
  assert.equal(run(rt, `isOwnAccount_('EVA CARLA RAMOS TORRES')`), true);
  assert.equal(run(rt, `isOwnAccount_('Ana Ramos Torres')`), false);
});

test("an e-mail addressed to the person by name is one source; the statement is the second", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`learnOwnNameFromMail_({ getTo: function () { return '"Eva Carla Ramos" <eva@example.test>'; } }, 'alerts@bank-a.test')`);
  assert.deepEqual(names(rt), []);
  learn(rt, [{ name: "EVA CARLA RAMOS", source: "stmt:1111" }]);
  assert.deepEqual(names(rt), ["Eva Carla Ramos"]);
  // an address alone, or several recipients, teach nothing
  assert.equal(run(rt, `ownerNameFromHeader_('eva@example.test')`), "");
  assert.equal(run(rt, `ownerNameFromHeader_('"Eva Carla" <eva@example.test>, "Luis Vega" <luis@example.test>')`), "");
});

test("statements teach the app while they are analysed, and an unpaired transfer in the person's own name is not a person", () => {
  const { rt, data } = freshApp({ entries: 60 });
  const [a, b] = data.pms.filter((p) => p.type === "debit");
  const stmt = (pm, holder, lines) => ({ key: pm.last_4, kind: "savings", holder, verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1 } }, file_name: "t.pdf", lines });
  const lines = [{ date: "2019-03-10", description: "TRANSF EVA", amount: 500, currency: "PEN" }, { date: "2019-03-11", description: "TRANSF LUIS", amount: 40, currency: "PEN" }];
  // Only one account has been seen: EVA still looks like a person.
  let p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt(a, "EVA CARLA RAMOS", lines)] })})`);
  assert.equal(p.summary.aside.filter((x) => x.reason === "person").length, 2);
  // The second account shows the same holder (other word order): the name is confirmed IN THIS analysis.
  p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt(a, "EVA CARLA RAMOS", lines), stmt(b, "RAMOS EVA CARLA", [])] })})`);
  assert.deepEqual(p.summary.aside.filter((x) => x.reason === "person").map((x) => x.personName), ["Luis"], "only the other person is left in the people group");
  assert.ok(p.summary.aside.some((x) => /TRANSF EVA/.test(x.description) && x.optInTransfer), "your own transfer can be counted as a transfer");
});

test("removing a name in My names forgets it, and a bad name is refused", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "s1" }, { name: "RAMOS TORRES EVA CARLA", source: "s2" }]);
  assert.equal(names(rt).length, 1);
  const saved = run(rt, `saveOwnerNames({ names: [] })`);
  assert.deepEqual(saved.names, []);
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "s3" }]);
  assert.deepEqual(names(rt), [], "forgotten: one new document is not enough again");
  assert.throws(() => rt.run(`saveOwnerNames({ names: ['Eva'] })`), /full name/);
  assert.deepEqual(run(rt, `saveOwnerNames({ names: ['Eva Ramos', 'EVA RAMOS'] })`).names, ["Eva Ramos"]);
});

test("the statement readers find the holder on every layout that prints one (fake statement text, made-up name)", () => {
  const SP = require("../../docs/statement-parsers.js");
  const rows = (...texts) => texts.map((text) => ({ text }));
  const f = SP.holderOf;
  assert.equal(f("bcp", rows("Estado de Cuenta de Ahorros Cuenta Digital BCP", "PAGINA 1 DE 1", "RAMOS TORRES EVA CARLA CODIGO DE CUENTA MONEDA")), "RAMOS TORRES EVA CARLA");
  assert.equal(f("savings", rows("ESTADO DE CUENTA", "CUENTA SIMPLE SOLES", "DEL 31 DE JULIO", "EVA CARLA RAMOS", "DNI 00000000")), "EVA CARLA RAMOS");
  assert.equal(f("diners", rows("RAMOS TORRES EVA CARLA 01/10/2026", "XXXX0000")), "RAMOS TORRES EVA CARLA");
  assert.equal(f("visa", rows("INTERBANK VISA INFINITE 0000", "RAMOS TORRES EVA CARLA", "LIMA")), "RAMOS TORRES EVA CARLA");
  assert.equal(f("sip", rows("OECHSLE PLAZAVEA", "EVA CARLA RAMOS TORRES (A) PAGO DEL MES 10.00")), "EVA CARLA RAMOS TORRES");
  assert.equal(f("ahorramas", rows("¡HOLA, EVA !")), "");
});
