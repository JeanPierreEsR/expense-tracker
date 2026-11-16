// WhatsApp capture (WhatsApp.gs): the Cloudflare relay forwards a message with its secret; it lands in Needs review, read by the
// bank e-mail rules first, then as a typed line. All values are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const send = (rt, msg, secret = SECRET) => {
  rt.ctx.__body = JSON.stringify({ whatsapp: msg, relay_secret: secret });
  return JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()"));
};
const waRows = (rt) => rt.rows("Entries").filter((e) => e.source === "whatsapp");
const now = () => Math.floor(Date.now() / 1000);

test("closed until the relay key is set, and only the right key gets in", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(send(rt, { id: "m1", text: "25 lunch", timestamp: now() }).ok, false);
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  assert.equal(send(rt, { id: "m1", text: "25 lunch", timestamp: now() }, "wrong").ok, false);
  assert.equal(waRows(rt).length, 0);
  const res = send(rt, { id: "m1", text: "25 lunch", timestamp: now() });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.saved, true);
  assert.match(res.data.reply, /PEN 25\.00/);
  const [e] = waRows(rt);
  assert.equal(e.status, "pending");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 25);
  assert.equal(e.currency, "PEN");
  assert.equal(e.description, "Lunch");
  // The relay key is not a sign-in.
  rt.ctx.__body = JSON.stringify({ accessCode: SECRET, action: "listEntries", payload: {} });
  assert.equal(JSON.parse(rt.run("doPost({ postData: { contents: __body } }).getContent()")).ok, false);
});

test("typed lines: currency signs, codes, words and income", () => {
  const { rt } = freshApp({ small: true });
  const read = (t) => JSON.parse(JSON.stringify(rt.run(`typedReadLine_(${JSON.stringify(t)}, "PEN")`)));
  assert.deepEqual(read("S/ 12.50 taxi"), { type: "expense", amount: 12.5, currency: "PEN", description: "Taxi" });
  assert.deepEqual(read("USD 10 Netflix"), { type: "expense", amount: 10, currency: "USD", description: "Netflix" });
  assert.deepEqual(read("US$4,99 app"), { type: "expense", amount: 4.99, currency: "USD", description: "App" });
  assert.deepEqual(read("almuerzo 30 soles"), { type: "expense", amount: 30, currency: "PEN", description: "Almuerzo" });
  assert.deepEqual(read("ingreso 1,500 sueldo"), { type: "income", amount: 1500, currency: "PEN", description: "Sueldo" });
  assert.equal(read("hola"), null);
  assert.equal(read("0 nada"), null);
});

test("a category is set only with its keyword after a comma, never from a word in the description", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  const cat = rt.rows("Categories").find((c) => c.type === "expense" && c.name === "Transport");
  assert.ok(cat, "seed has Transport");
  send(rt, { id: "m2", text: "18 taxi transport", timestamp: now() });
  assert.equal(waRows(rt)[0].description, "Taxi transport");
  assert.notEqual(waRows(rt)[0].category_id, cat.id);
  const res = send(rt, { id: "m3", text: "19 bus, category transport", timestamp: now() });
  const bus = waRows(rt).find((e) => e.description === "Bus");
  assert.equal(bus.category_id, cat.id);
  assert.ok(res.data.reply, "the relay still gets one reply to send");
});

test("Meta sending the same message twice saves it once", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  send(rt, { id: "wamid.same", text: "9 coffee", timestamp: now() });
  const again = send(rt, { id: "wamid.same", text: "9 coffee", timestamp: now() });
  assert.equal(again.data.repeat, true);
  assert.equal(waRows(rt).length, 1);
});

test("a pasted bank notice is read by the e-mail rules, and the bank's own e-mail is not saved again", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  const text = [
    "Realizaste un consumo con tu tarjeta de débito BCP",
    "Total del consumo: S/ 41.30",
    "Empresa: Corner Grocer",
    "Número de Tarjeta de Débito: ****1234",
    "Número de operación: 777888"
  ].join("\n");
  const res = send(rt, { id: "m3", text, timestamp: now() });
  assert.equal(res.data.saved, true, JSON.stringify(res));
  const [e] = waRows(rt);
  assert.equal(Number(e.amount), 41.3);
  assert.equal(e.description, "Corner Grocer");
  assert.equal(e.external_id, "777888");
  // The same purchase's e-mail arrives later: no second entry.
  const before = rt.rows("Entries").length;
  bcpEmail(rt, { amount: "41.30", merchant: "Corner Grocer", op: "777888" });
  rt.run("processEmails()");
  assert.equal(rt.rows("Entries").length, before);
  // ...while a different purchase's e-mail still is (the scan really ran).
  bcpEmail(rt, { amount: "12.00", merchant: "Other Shop", op: "999000" });
  rt.run("processEmails()");
  assert.equal(rt.rows("Entries").length, before + 1);
});

test("a message with no amount is answered, nothing saved", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  const res = send(rt, { id: "m4", text: "hello there", timestamp: now() });
  assert.equal(res.data.saved, false);
  assert.match(res.data.reply, /couldn't find an amount/);
  assert.equal(waRows(rt).length, 0);
});
