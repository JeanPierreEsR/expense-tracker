// Receipt-photo text reading: Tesseract (Mac Mini) output variants. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const parse = (rt, text) => rt.run("parsePhotoReceipt_(" + JSON.stringify(text) + ")");

// Tesseract dropped the big "S/" completely: the amount is a bare "12.50 u".
const PLIN_NO_PREFIX = [
  "Pl interbank", "", "¡Plineaste!", "", "Ana Lo* C", "", "... 0...", "",
  "334 - Yape", "", "12.50 u", "", "05 Oct 2026 | 10:30 AM", "",
  "Código de operación: 01234567", "", "Solo con Interbank paga a Plin"
].join("\n");

test("plin photo: amount line with the S/ lost ('12.50 u') is still read", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, PLIN_NO_PREFIX);
  assert.equal(r.amount, 12.5);
  assert.equal(r.currency, "PEN");
  assert.equal(r.externalId, "01234567");
});

test("plin photo: masked card line, date and code are never taken as the amount", () => {
  const { rt } = freshApp({ small: true });
  const text = PLIN_NO_PREFIX.replace("12.50 u", "");
  assert.equal(parse(rt, text).error, "amount");
});

// Received Yape ("¡Te Yapearon!"): same lost-"S/" reading, plus an ad line below.
const YAPE_NO_PREFIX = [
  "¡Te Yapearon!", "", "18.00 a", "", "Ana Lo*", "05 Oct 2026 | 09:15 a.m.",
  "Código de operación: 00765432", "", "*$150 y gana con tu Yape", "Compartir"
].join("\n");

test("yape received: amount line with the S/ lost is read, ad line ignored", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPE_NO_PREFIX);
  assert.equal(r.kind, "yape_received");
  assert.equal(r.type, "income");
  assert.equal(r.amount, 18);
  assert.equal(r.counterparty, "Ana Lo*");
  assert.equal(r.externalId, "00765432");
});

test("yape received: normal 'S/ 18.00' reading still wins", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPE_NO_PREFIX.replace("18.00 a", "S/ 18.00"));
  assert.equal(r.amount, 18);
});

// ---- "¡Yapeaste!" (sent) image; income when the name on it is the owner's ----
const YAPEASTE = [
  "¡Yapeaste!", "", "S/ 6.50", "", "Mia Dua*", "08 oct. 2026 | 3:10 p.m.", "almuerzo del menu", "",
  "CÓDIGO DE SEGURIDAD", "6 1 2", "DATOS DE LA TRANSACCIÓN", "Nro. de celular *** *** 278", "Destino Yape",
  "Nro. de operación 00987654"
].join("\n");

test("yapeaste image: expense to the named person, with the typed message, on the BCP account", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPEASTE);
  assert.equal(r.kind, "yape_sent");
  assert.equal(r.type, "expense");
  assert.equal(r.amount, 6.5);
  assert.equal(r.currency, "PEN");
  assert.equal(r.counterparty, "Mia Dua*");
  assert.equal(r.description, "Yape a Mia Dua* — almuerzo del menu");
  assert.equal(r.externalId, "00987654");
  assert.equal(r.date, "2026-10-08");
  assert.equal(r.time, "15:10:00");
  assert.equal(r.accountByCurrency.PEN, "BCP soles");
});

test("owner name matching: masked surname prefix, accents, several variants; a lone first name never matches", () => {
  const { rt } = freshApp({ small: true });
  const m = (name, owners) => rt.run(`photoIsOwnerName_(${JSON.stringify(name)}, ${JSON.stringify(owners)})`);
  assert.equal(m("Ana Per*", "Ana Maria Perez"), true);
  assert.equal(m("Ana Per*", "Pedro Lopez, Ana Perez"), true, "any variant may match");
  assert.equal(m("Ana Per*", "Pedro Lopez"), false);
  assert.equal(m("Ana*", "Ana Perez"), false, "a single word is not enough");
  assert.equal(m("Mia Dua*", "Ana Perez"), false);
  assert.equal(m("Ana Per*", ""), false);
  assert.equal(m("Ánä Pér*", "Ana Perez"), true);
});

function processYapeaste(rt, ownerNames, text) {
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-bot-token");
  rt.svc.props.set("TELEGRAM_CHAT_ID", "555");
  if (ownerNames) rt.run(`appendRowObject('Settings', { key: 'owner_names', value: ${JSON.stringify(ownerNames)} })`);
  const before = rt.rows("Entries").length;
  rt.run(`processPhotoText_(555, 1, ${JSON.stringify(text)})`);
  const added = rt.rows("Entries").slice(before);
  assert.equal(added.length, 1);
  return added[0];
}

test("yapeaste image to someone else becomes a pending expense", () => {
  const { rt } = freshApp({ small: true });
  const e = processYapeaste(rt, "Ana Perez", YAPEASTE);
  assert.equal(e.type, "expense");
  assert.equal(e.status, "pending");
  assert.equal(e.source, "photo");
  assert.equal(e.paid_by, "me");
  assert.equal(Number(e.amount), 6.5);
});

test("yapeaste image whose name is the owner's becomes a pending INCOME, and says so", () => {
  const { rt } = freshApp({ small: true });
  const e = processYapeaste(rt, "Pedro Lopez, Mia Duarte", YAPEASTE);
  assert.equal(e.type, "income");
  assert.equal(e.status, "pending");
  assert.equal(e.paid_by, "");
  assert.equal(e.description, "Yape recibido — almuerzo del menu");
  const sent = rt.svc.fetchLog.map((f) => String(f.options.payload)).join(" ");
  assert.match(sent, /matches yours/);
});

test("with no owner_names setting a yapeaste image is just an expense", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(processYapeaste(rt, "", YAPEASTE).type, "expense");
});

test("the same yapeaste image sent twice is only recorded once", () => {
  const { rt } = freshApp({ small: true });
  processYapeaste(rt, "", YAPEASTE);
  const before = rt.rows("Entries").length;
  rt.run(`processPhotoText_(555, 2, ${JSON.stringify(YAPEASTE)})`);
  assert.equal(rt.rows("Entries").length, before);
});

// What Tesseract really produced for such a screen (several passes joined): the big amount
// read as "S14" or lost, noise lines before the name, a stray icon letter before the message.
const YAPEASTE_NOISY = [
  "INONES", "", "jYapeaste!", "", "Si A", "", "Mia Dua*", "© 08 oct. 2026 | © 3:10 p.m.", "", "B almuerzo del menu", "",
  "CODIGO DE SEGURIDAD", "DATOS DE LA TRANSACCION", "Nro. de operacién 00987654",
  "", "iYapeaste!", "S 6", "Mia Dua*"
].join("\n").replace("S 6", "S/ 6.50".replace("/ ", "1").replace(".50", ".50"));

test("noisy Tesseract text: the masked name beats noise lines, the stray icon letter is dropped, 'S1' + amount is read", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPEASTE_NOISY);
  assert.equal(r.counterparty, "Mia Dua*");
  assert.equal(r.note, "almuerzo del menu");
  assert.equal(r.amount, 6.5);
});
