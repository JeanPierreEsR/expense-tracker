// Credit-card statement readers (docs/statement-parsers.js): any Interbank card name, and BCP cards
// (Visa, American Express, …). Every row below is made up; it only mimics the layout the readers expect.
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

function row(...cells) {
  let x = 20;
  const cs = cells.map((c) => {
    if (typeof c !== "string") return c;
    const cell = { str: c, x0: x, x1: x + c.length * 5 };
    x = cell.x1 + 10;
    return cell;
  });
  return { text: cs.map((c) => c.str).join(" "), cells: cs };
}
const at = (str, x0) => ({ str, x0, x1: x0 + str.length * 5 });

// ---------- Interbank: every card name ----------

const pen = (v) => ({ str: v, x0: 400, x1: 440 });
const usd = (v) => ({ str: v, x0: 520, x1: 560 });

function interbank(cardLine) {
  return [
    row(cardLine),
    row("Ana Lo*"),
    row("Queremos contarte todo lo que necesitas saber en www.interbank.pe"),
    row("del 26/08/2026 al cierre de 25/09/2026"),
    row("DETALLE DE PAGO DEL MES"),
    row("TU ESTADO DE CUENTA ANTERIOR", { str: "S/", x0: 420, x1: 440 }, { str: "US$", x0: 560, x1: 580 }),
    row("Debías en el estado de cuenta anterior *", pen("100.00"), usd("0.00")),
    row("PAGOS REALIZADOS"),
    row("05-Sep", "PAGO TARJ WEB APP", pen("-100.00"), usd("0.00")),
    row("SUBTOTAL ----", pen("0.00"), usd("0.00")), // the previous balance belongs to this subtotal
    row("TUS CONSUMOS"),
    row("10-Sep", "SHOP ONE", pen("30.00"), usd("0.00")),
    row("SUBTOTAL ----", pen("30.00"), usd("0.00")),
    row("OTROS COBROS"),
    row("SUBTOTAL ----", pen("0.00"), usd("0.00")),
    row("PAGO DEL MES (Suma de subtotales)", pen("30.00"), usd("0.00"))
  ];
}

for (const [card, label] of [
  ["INTERBANK VISA INFINITE 4772 89** **** 1234 - SOLES", "Interbank Visa Infinite"],
  ["VISA CLASICA INTERNACIONAL 4772 89** **** 1234 - SOLES", "Interbank Visa Clasica Internacional"],
  ["AMERICAN EXPRESS PLATINUM 3759 87** **** 1234 - SOLES", "Interbank American Express Platinum"],
  ["AMERICAN EXPRESS 3759 87**** *1234", "Interbank American Express"],
  ["MASTERCARD BLACK 5412 75** **** 1234 - DÓLARES", "Interbank Mastercard Black"]
]) {
  test(`Interbank card "${card}" is recognised, named and read`, () => {
    const r = SP.parseStatement(interbank(card));
    assert.equal(r.kind, "visa");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.account.last4, "1234");
    assert.equal(r.account.label, label);
    assert.equal(r.period.end, "2026-09-25");
    assert.equal(r.lines.length, 2);
  });
}

test("a page that only mentions Interbank is not read as a card statement", () => {
  const r = SP.parseStatement([row("www.interbank.pe"), row("Estado de cuenta de algo")]);
  assert.equal(r.kind, null);
});

// ---------- BCP cards ----------

// "Soles" heading starts at x=400, "Dólares" at x=480: amounts starting left of 480 are soles.
const bpen = (v) => at(v, 410);
const busd = (v) => at(v, 500);

function bcp(title, { totalPen = "49.50", dateTail = "26/10/25" } = {}) {
  return [
    row(at(`Estado de Cuenta Tarjeta ${title}`, 20), at("Pag 1", 450), at("de 2", 500)),
    row(at("Ciclo de Facturación", 300)),
    row(at("Ana Lo*", 20), at("Número de tarjeta", 200), at("Del", 300), at("Al", 340)),
    row(at("Calle Falsa 123", 20), at("4557-88XX-XXXX-1234", 200), at("27/09/25", 300), at(dateTail, 340)),
    row(at("Fecha de", 20), at("Fecha de", 60), at("Descripción", 120), at("Tipo de", 250), at("Soles", 400), at("Dólares", 480)),
    row(at("SALDO ANTERIOR", 120), bpen("100.00"), busd("10.00")),
    row(at("12Oct", 20), at("10Oct", 60), at("SHOP ONE", 120), at("LIMA", 190), at("PE", 220), at("CONSUMO", 250), bpen("50.00")),
    row(at("14Oct", 20), at("14Oct", 60), at("SOFTWARE CO", 120), at("CA", 220), at("CONSUMO", 250), busd("20.00")),
    row(at("15Oct", 20), at("15Oct", 60), at("PAGO BANCA MOVIL", 120), at("PAGO", 250), bpen("100.00-")),
    row(at("20Oct", 20), at("19Oct", 60), at("SHOP TWO", 120), at("LIMA", 190), at("DEVOLUCION", 250), bpen("5.00-")),
    row(at("¿Cómo calcular tu pago mínimo?", 20)),
    row(at("En soles", 20), bpen("99.99"), bpen("9.99")),
    row(at("INTERESES", 120), bpen("3.00")),
    row(at("COMISION POR USO DE CANALES", 120)),
    row(at("SUB TOTAL", 120), bpen("48.00"), busd("30.00")),
    row(at("GASTO MENSUAL POR SEGURO DE", 120), at("DESGRAVAMEN", 250), bpen("1.50")),
    row(at("COMISION ANUAL POR MEMBRESIA", 120)),
    row(at("MONTO TOTAL FACTURADO", 120), bpen(totalPen), busd("30.00"))
  ];
}

for (const title of ["VISA", "American Express", "Mastercard Black", "VISA SIGNATURE"]) {
  test(`BCP card "${title}" is read, named and verified`, () => {
    const r = SP.parseStatement(bcp(title));
    assert.equal(r.kind, "bcpcard");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.bank, "BCP");
    assert.equal(r.account.last4, "1234");
    assert.equal(r.account.label.toLowerCase(), `bcp ${title.toLowerCase()}`);
    assert.deepEqual(r.period, { start: "2025-09-27", end: "2025-10-26" });
    assert.deepEqual(r.balances, { PEN: { opening: -100, closing: -49.5 }, USD: { opening: -10, closing: -30 } });
  });
}

test("BCP card lines: sign, currency, consumption date, payments and refunds, fees", () => {
  const r = SP.parseStatement(bcp("VISA"));
  const by = (d) => r.lines.find((l) => l.description.startsWith(d));
  assert.deepEqual(by("SHOP ONE"), { date: "2025-10-10", description: "SHOP ONE LIMA PE", amount: -50, currency: "PEN", section: "purchases" });
  assert.deepEqual(by("SOFTWARE CO"), { date: "2025-10-14", description: "SOFTWARE CO CA", amount: -20, currency: "USD", section: "purchases" });
  assert.equal(by("PAGO BANCA").amount, 100);
  assert.equal(by("PAGO BANCA").section, "payments");
  assert.equal(by("SHOP TWO").amount, 5);
  assert.equal(by("SHOP TWO").section, "refunds");
  assert.equal(by("INTERESES").amount, -3);
  assert.equal(by("GASTO MENSUAL").description, "GASTO MENSUAL POR SEGURO DE DESGRAVAMEN");
  assert.equal(r.lines.length, 6, "the 'how to compute your minimum payment' table is not read as lines");
});

test("BCP card: a total that does not add up is rejected", () => {
  const r = SP.parseStatement(bcp("VISA", { totalPen: "60.00" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /49\.50.*60\.00/);
});

test("BCP card: a December purchase on a cycle ending in January belongs to the year before", () => {
  const rows = bcp("VISA", { dateTail: "26/01/26" });
  rows[3] = row(at("Calle Falsa 123", 20), at("4557-88XX-XXXX-1234", 200), at("27/12/25", 300), at("26/01/26", 340));
  rows[6] = row(at("30Dic", 20), at("29Dic", 60), at("SHOP ONE", 120), at("CONSUMO", 250), bpen("50.00"));
  const r = SP.parseStatement(rows);
  assert.equal(r.lines.find((l) => l.description === "SHOP ONE").date, "2025-12-29");
});

test("BCP card without a readable card number is reported, not guessed", () => {
  const rows = bcp("VISA");
  rows[3] = row(at("Calle Falsa 123", 20), at("27/09/25", 300), at("26/10/25", 340));
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, false);
});

test("the BCP savings reader is not confused with the card layout", () => {
  assert.equal(SP.detectKind([row("Estado de Cuenta de Ahorros"), row("FECHA PROC")]), "bcp");
});
