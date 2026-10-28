// Masked card/account digits printed after a label ("************1234", "**** 1234", "**** ****** 1234"): backend/EmailParser.gs lastFourAfter_.
// Found 2026-10-28 on the owner's real e-mails: afterLabel_ cleans the value and deletes every "*", while extractLast4_ needs two, so the digits of the
// BCP purchase / utility bill / third-party transfer, the Diners card payment and the Interbank card-debt payment were never read. Made-up text only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const js = (v) => JSON.stringify(v);
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const four = (rt, body, label) => rt.run(`lastFourAfter_(${js(body)}, ${js(label)})`);
const scan = (rt) => { rt.svc.props.delete("EMAIL_SCAN_LAST_AT"); return rt.api("checkEmailsNow"); };
const BCP = "notificaciones@notificacionesbcp.com.pe";
const DINERS_PAY = "dinersenlinea@dinersclub.com.pe";
const pmByNick = (rt, nick) => rt.rows("Payment Methods").find((p) => p.nickname === nick);
const entryWith = (rt, externalId) => rt.rows("Entries").find((e) => e.source === "email" && e.external_id === externalId);

test("every way a bank prints a masked number gives its last four digits", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(four(rt, "Número de Tarjeta de Débito          ************1234\nEmpresa X", "Número de Tarjeta de Débito"), "1234");
  assert.equal(four(rt, "Cuenta de origen: **** 5678\nJUAN", "Cuenta de origen"), "5678");
  assert.equal(four(rt, "Tarjeta: **** ****** 4321\nUsted podrá", "Tarjeta"), "4321");
  assert.equal(four(rt, "Tarjeta de crédito: ************1111\nMonto pagado: S/ 20.00", "Tarjeta de crédito"), "1111");
  assert.equal(four(rt, "Desde Clasica\n**** 2468\nMoneda Soles", "Desde"), "2468", "the number on the line after the label");
  assert.equal(four(rt, "Cuenta de origen: XXXX 1357", "Cuenta de origen"), "1357", "X as the mask");
  assert.equal(four(rt, "Tarjeta: •••• 9753", "Tarjeta"), "9753", "bullets as the mask");
});

test("a label that appears twice: the first place WITHOUT a masked number does not hide the second", () => {
  const { rt } = freshApp({ small: true });
  // BCP: "desde" is in the intro sentence and again in the data block; Diners: "tarjeta" is in "Usuario de tarjeta" too
  assert.equal(four(rt, "Realizaste una transferencia de S/ 50.00 desde\ntu Clasica. Por tu seguridad...\n\nDesde Clasica\n**** 1122\nMoneda Soles", "Desde"), "1122");
  assert.equal(four(rt, "Usuario de tarjeta: ANA PRUEBA\nFecha y hora: 28/08/2026 10:30\nMonto: $ 10.00\nTarjeta: **** ****** 3344\nUsted podrá", "Tarjeta"), "3344");
});

test("no false digits: dates, amounts, operation numbers and a label with no masked number give nothing", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(four(rt, "Tarjeta: ANA PRUEBA\nFecha y hora: 28/08/2026 10:30", "Tarjeta"), null);
  assert.equal(four(rt, "Número de operación 123456\nMonto S/ 1234.50", "Número de operación"), null, "digits without a mask are not card digits");
  assert.equal(four(rt, "Desde\ntu cuenta", "Desde"), null);
  assert.equal(four(rt, "", "Desde"), null);
  assert.equal(four(rt, null, "Desde"), null);
});

test("a label missing from the e-mail: the whole e-mail is searched, as the rules always did", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(four(rt, "Pagaste con la tarjeta ****9876 hoy", "Tarjeta de crédito"), "9876");
  assert.equal(four(rt, "Sin ningún número enmascarado", "Tarjeta de crédito"), null);
});

test("the five rules now read the digits from the e-mails the owner's banks really send", () => {
  const { rt } = freshApp({ small: true });
  const read = (sender, subject, body, label) => plain(rt.run(`(function () { var r = readEmailWithRules_(${js(sender)}, ${js(subject)}, ${js(body)}); return r.fields && r.rule.label === ${js(label)} ? r.fields.last4 : 'NOT READ BY ' + (r.rule && r.rule.label); })()`));
  assert.equal(read(BCP, "Realizaste un consumo con tu Tarjeta de Débito BCP", "Total del consumo $ 15.00\nEmpresa TIENDA\nNúmero de Tarjeta de Débito ************1234\nNúmero de operación 1", "Consumo tarjeta de débito"), "1234");
  assert.equal(read(BCP, "ENVIO AUTOMATICO - CONSTANCIA DE PAGO DE SERVICIO - BANCA MOVIL BCP", "Cuenta de origen: **** 5678\nMonto total: S/ 9.00\nEmpresa LUZ", "Pago de servicios"), "5678");
  assert.equal(read(BCP, "Constancia de transferencia a terceros", "Realizaste una transferencia de S/ 9.00 desde\ntu Clasica.\nDesde Clasica\n**** 2468\nMonto transferido S/ 9.00\nEnviado a X", "Transferencia a terceros"), "2468");
  assert.equal(read(DINERS_PAY, "Comprobante de pago", "Usuario de tarjeta: ANA\nMonto: $ 9.00\nTarjeta: **** ****** 3458", "Pago de tarjeta (transferencia interna)"), "3458");
  assert.equal(read("notificaciones@interbank.pe", "Pago de tu tarjeta", "Tarjeta de crédito: ************5738\nMonto pagado: S/ 9.00", "Pago de deuda (transferencia interna)"), "5738");
});

// ---- what the digits do to the entry's account ----
test("a BCP purchase now goes to the account whose digits the e-mail names (before, it had no account at all)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: BCP, subject: "Realizaste un consumo con tu Tarjeta de Débito BCP", body: "Total del consumo: S/ 21.00\nEmpresa: Tienda Masked\nNúmero de Tarjeta de Débito: ************7026\nNúmero de operación: 990011", daysAgo: 0 });
  scan(rt);
  assert.equal(entryWith(rt, "990011").payment_method_id, pmByNick(rt, "Savings").id, "the BCP account ending 7026, not the other two");
});

test("digits that do not match any registered account leave the account blank for the person to pick (the person DID register digits)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: BCP, subject: "Realizaste un consumo con tu Tarjeta de Débito BCP", body: "Total del consumo: S/ 22.00\nEmpresa: Tienda Masked\nNúmero de Tarjeta de Débito: ************0000\nNúmero de operación: 990012", daysAgo: 0 });
  scan(rt);
  assert.equal(entryWith(rt, "990012").payment_method_id, "");
});

test("a card payment names the card it paid: Diners, and Interbank, put it in 'To'", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: DINERS_PAY, subject: "Comprobante de pago", body: "Usuario de tarjeta: ANA PRUEBA\nFecha y hora: 28/08/2026 10:30\nMonto: S/ 100.00\nTarjeta: **** ****** 3458\nOperación: 55501", daysAgo: 0 });
  rt.svc.gmail.addEmail({ from: "notificaciones@interbank.pe", subject: "Pago de tu tarjeta", body: "Tarjeta de crédito: ************5738\nMonto pagado: S/ 200.00\ncódigo de operación 55502", daysAgo: 0 });
  scan(rt);
  const d = entryWith(rt, "55501"), i = entryWith(rt, "55502");
  assert.equal(d.type, "transfer");
  assert.equal(d.to_payment_method_id, pmByNick(rt, "Shop card").id);
  assert.equal(i.to_payment_method_id, pmByNick(rt, "Travel card").id);
});

test("nothing is lost for a person who never filled in the digits: the bank's only account still takes the entry", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`updateRowFields_('Payment Methods', ${js(pmByNick(rt, "Shop card").id)}, { last_4: '' })`);
  rt.svc.gmail.addEmail({ from: DINERS_PAY, subject: "Comprobante de pago", body: "Monto: S/ 100.00\nTarjeta: **** ****** 3458\nOperación: 55503", daysAgo: 0 });
  scan(rt);
  assert.equal(entryWith(rt, "55503").to_payment_method_id, pmByNick(rt, "Shop card").id, "the e-mail's digits cannot disprove an account that has none");
});

test("digits that DO NOT match an account that has digits stay blank, even when it is the bank's only account", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: DINERS_PAY, subject: "Comprobante de pago", body: "Monto: S/ 100.00\nTarjeta: **** ****** 0001\nOperación: 55504", daysAgo: 0 });
  scan(rt);
  assert.equal(entryWith(rt, "55504").to_payment_method_id || "", "");
});
