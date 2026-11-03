// Amazon.com "Shipped …" e-mail (Amazon charges the card when it ships) -> a pending expense with no card, and the card's own bank e-mail
// for the same charge -> the SAME entry, not a second one (EmailParser.gs, amazonShipmentTwin_). Diners sends no e-mail for Amazon charges
// (owner, 2026-11-02). The e-mails here are MADE UP but keep the real labels and layout.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, BCP_SENDER } = require("./helpers");

const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const amazonRows = (rt) => rt.rows("Entries").filter((e) => e.source === "email" && /amazon|amzn/i.test(e.merchant || ""));

const shipped = (rt, { total = "$42.10", n = "111-0000000-0000001", subject = "Shipped 3 items: Electronics, Books, and more", daysAgo = 1 } = {}) =>
  rt.svc.gmail.addEmail({
    from: "Amazon.com <shipment-tracking@amazon.com>", subject, daysAgo,
    body: ["Your Orders Your Account", "", "Eva, your package was shipped!", "", "Ordered Shipped Out for delivery Delivered", "",
      "Arriving Friday", "3 items: 1 Electronics, 1 Books, and 1 other", "Eva - Lima, Lima", "Order # " + n, "", "Track package", "",
      "Total", "", total, "", "View related transactions in Your Transactions.", "", "©2026 Amazon.com, Inc. or its affiliates."].join("\n")
  });

// The card's bank e-mail for the charge (BCP's purchase layout, in dollars).
const charge = (rt, { amount = "42.10", op = "000222", daysAgo = 0 } = {}) => rt.svc.gmail.addEmail({
  from: BCP_SENDER, subject: "Realizaste un consumo con tu tarjeta de débito BCP", daysAgo,
  body: ["Total del consumo: US$ " + amount, "Empresa: AMAZON MKTPL", "Número de Tarjeta de Débito: ****6622", "Número de operación: " + op].join("\n")
});

const nickname = (rt, id) => (rt.rows("Payment Methods").find((p) => p.id === id) || {}).nickname || "";
// Which account a lone BCP charge lands on in this test data (the test then expects the shipment to get the same one).
const chargeAccount = () => {
  const { rt } = freshApp({ small: true });
  charge(rt);
  run(rt);
  return nickname(rt, amazonRows(rt)[0].payment_method_id);
};

test("an Amazon shipment is a pending expense in dollars, with no account, read once", () => {
  const { rt } = freshApp({ small: true });
  shipped(rt);
  run(rt);
  const [e] = amazonRows(rt);
  assert.ok(e, "an entry was created");
  assert.equal(e.type, "expense");
  assert.equal(e.status, "pending");
  assert.equal(Number(e.amount), 42.1);
  assert.equal(e.currency, "USD");
  assert.equal(e.payment_method_id, "");
  assert.equal(e.external_id, "amazon-111-0000000-0000001-42.10");
  assert.equal(e.description, "Amazon - 3 items: Electronics, Books, and more");
  const n = rt.rows("Entries").length;
  run(rt);
  assert.equal(rt.rows("Entries").length, n);
});

test("a one-item shipment keeps the item's name", () => {
  const { rt } = freshApp({ small: true });
  shipped(rt, { subject: 'Shipped: "Made-up Phone Case..."' });
  run(rt);
  assert.equal(amazonRows(rt)[0].description, "Amazon - Made-up Phone Case...");
});

test("one order shipped in two packages is two entries, one per package", () => {
  const { rt } = freshApp({ small: true });
  shipped(rt, { total: "$30.00" });
  shipped(rt, { total: "$12.10" });
  run(rt);
  assert.deepEqual(amazonRows(rt).map((e) => Number(e.amount)).sort(), [12.1, 30]);
});

test("the order confirmation is not read (only the shipment is)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: "Amazon.com <auto-confirm@amazon.com>", subject: "Ordered 3 items: Electronics, Books, and more",
    body: "Order # 111-0000000-0000001\nGrand Total:\n$42.10" });
  run(rt);
  assert.equal(amazonRows(rt).length, 0);
});

test("the card's bank e-mail for the charge fills in the shipment's account instead of making a second entry", () => {
  const expected = chargeAccount();
  assert.ok(expected, "the test data puts a BCP charge on an account");
  const { rt } = freshApp({ small: true });
  shipped(rt);
  run(rt);
  charge(rt);
  run(rt);
  const rows = amazonRows(rt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id, "amazon-111-0000000-0000001-42.10");
  assert.equal(nickname(rt, rows[0].payment_method_id), expected);
  // The bank e-mail read again (its "handled" note gone) is still the same purchase.
  charge(rt, { op: "000223" });
  run(rt);
  assert.equal(amazonRows(rt).length, 1);
});

test("a shipment e-mail read AFTER the bank's charge makes no second entry", () => {
  const { rt } = freshApp({ small: true });
  charge(rt);
  run(rt);
  shipped(rt);
  run(rt);
  assert.equal(amazonRows(rt).length, 1);
});

test("a charge of a different amount is a different purchase", () => {
  const { rt } = freshApp({ small: true });
  shipped(rt);
  run(rt);
  charge(rt, { amount: "30.00" });
  run(rt);
  assert.equal(amazonRows(rt).length, 2);
});

test("an Amazon shipment e-mail with no Total makes no entry", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.gmail.addEmail({ from: "Amazon.com <shipment-tracking@amazon.com>", subject: "Shipped: \"Made-up Book\"", body: "Order # 111-0000000-0000009\nTrack package" });
  run(rt);
  assert.equal(amazonRows(rt).length, 0);
});
