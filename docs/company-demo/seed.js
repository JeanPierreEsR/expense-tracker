// The company test copy's made-up company (plan "Empresa de prueba en el teléfono", 2026-11-27): shaped like the first company pilot
// (a building sold flat by flat, partners, lenders, SUNAT's withholding), with invented names and amounts only. Everything is
// recorded through the backend's own actions, as a person would, so the data is exactly what the app makes. About 3 months.
(function (root) {
  "use strict";

  // Today and other days in Lima (the copy's time zone), as yyyy-MM-dd.
  const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));
  const monthsAhead = (n, day) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 8) + String(day).padStart(2, "0"); };

  // A small fixed random series, so every new test copy has the same data.
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647; };
  const between = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;

  function seed(engine) {
    const api = engine.api;
    api("saveOnboarding", { language: "es", dateOrder: "dmy", homeCurrency: "PEN", currencies: ["USD"] });
    const setup = api("saveCompanySetup", { sector: "construction", name: "Inmobiliaria Demo SAC", projects: ["Edificio Los Pinos", "Edificio Miraflores", "Casa Las Flores"] });
    const company = setup.company;
    const [pinos, miraflores, flores] = setup.projects;
    // A waiting entry written the way the bank e-mails write one (straight into the sheet, no company: the copy adds it).
    const waiting_ = (row) => engine.run("appendRowObject('Entries', " + JSON.stringify(row) + "); ROWS_MEMO_ = null;");
    const where = (p) => ({ company_id: company.id, project_id: p.id });

    // Accounts: soles, dollars, and the built-in Cash; each starts with a balance 100 days ago.
    const bank = (engine.rows("Banks").find((b) => b.name === "BCP") || {}).id || "";
    const soles = api("addPaymentMethod", { nickname: "Cuenta corriente soles", type: "debit", bank_id: bank, last_4: "1001" });
    const dolares = api("addPaymentMethod", { nickname: "Cuenta corriente dólares", type: "debit", bank_id: bank, last_4: "2002" });
    api("setPaymentMethodOpeningBalance", { id: soles.id, balances: [{ currency: "PEN", amount: 85000, date: daysAgo(100) }] });
    api("setPaymentMethodOpeningBalance", { id: dolares.id, balances: [{ currency: "USD", amount: 40000, date: daysAgo(100) }] });

    // The dollar's rate for each month of the data (made-up, near the real level).
    for (let m = -4; m <= 0; m++) api("setExchangeRate", { currency: "USD", month: monthsAhead(m, 1).slice(0, 7), rate: [3.79, 3.76, 3.74, 3.72, 3.71][m + 4] });

    // "Casa Las Flores" is a finished project; "Edificio Los Pinos" still needs money.
    api("updateProject", { id: flores.id, name: flores.name, company_id: company.id, status: "closed" });
    api("setProjectFunding", { project_id: pinos.id, amount: 350000, currency: "USD", as_of: daysAgo(3) });

    const cats = engine.rows("Categories").filter((c) => c.hidden !== "yes");
    const cat = (type, key, name) => (cats.find((c) => c.type === type && (c.key === key || c.name === name)) || cats.find((c) => c.type === type) || {}).id;
    const materials = cat("expense", "materials", "Materials"), labor = cat("expense", "labor", "Labor");
    const design = cat("expense", "design_permits", "Design & permits"), notary = cat("expense", "notary_registries", "Notary & registries");
    const fees = cat("expense", "bank_fees", "Bank fees"), interest = cat("expense", "loan_interest", "Loan interest");

    // Units, each building its own (Units.gs): Los Pinos 101-805, Miraflores 101-405 (so both have a "Depa 101"); a few sold, with
    // what each buyer pays by stage.
    const flats = (floors) => { const out = []; for (let f = 1; f <= floors; f++) for (let n = 1; n <= 5; n++) out.push("Depa " + f + "0" + n); return out; };
    api("addProjectUnits", { project_id: pinos.id, names: flats(8) });
    api("addProjectUnits", { project_id: miraflores.id, names: flats(4) });
    const unitsOf = { [pinos.id]: api("listProjectUnits", { project_id: pinos.id }).units, [miraflores.id]: api("listProjectUnits", { project_id: miraflores.id }).units };
    const sales = [
      { p: pinos, unit: "Depa 101", buyer: "Rosa Quispe Demo", price: 98000, paid: [["reservation", 2000, 80], ["down_payment", 19600, 60]] },
      { p: pinos, unit: "Depa 203", buyer: "Luis Mendoza Demo", price: 105000, paid: [["reservation", 2000, 55], ["down_payment", 21000, 30]] },
      { p: pinos, unit: "Depa 405", buyer: "Carla Torres Demo", price: 112000, paid: [["reservation", 2000, 20]] },
      { p: pinos, unit: "Depa 802", buyer: "Jorge Salas Demo", price: 135000, paid: [["reservation", 3000, 9]] },
      { p: miraflores, unit: "Depa 101", buyer: "Elena Ríos Demo", price: 120000, paid: [["reservation", 2500, 40]] },
      { p: miraflores, unit: "Depa 304", buyer: "Martín Vega Demo", price: 128000, paid: [["reservation", 2500, 25], ["down_payment", 23100, 6]] }
    ];
    sales.forEach((s) => {
      const u = unitsOf[s.p.id].find((x) => x.name === s.unit);
      api("saveUnit", { id: u.id, buyer_name: s.buyer, price: s.price, currency: "USD", status: s.paid.length > 1 ? "Cuota inicial" : "Separado" });
      const reserve = s.paid[0][1], down = Math.round(s.price * 0.2);
      api("saveUnitStage", { unit_id: u.id, stage: "reservation", amount: reserve, due_date: daysAgo(s.paid[0][2]) });
      api("saveUnitStage", { unit_id: u.id, stage: "down_payment", amount: down - reserve, due_date: s.paid[1] ? daysAgo(s.paid[1][2]) : monthsAhead(1, 15) });
      api("saveUnitStage", { unit_id: u.id, stage: "balance", amount: s.price - down, due_date: monthsAhead(6, 30) });
      s.paid.forEach(([stage, amount, ago]) => api("createEntry", Object.assign({ type: "income", date: daysAgo(ago), amount, currency: "USD",
        category_id: cat("income", "", stage === "reservation" ? "Reservation deposits" : "Down payments"),
        description: (stage === "reservation" ? "Separación " : "Cuota inicial ") + s.unit, payment_method_id: dolares.id, paid_by: "me", unit_id: u.id }, where(s.p))));
    });

    // Partners: two of them put money in; one profit distribution with its withholding.
    api("addPartnerMoney", Object.assign({ direction: "in", kind: "contribution", amount: 60000, currency: "PEN", date: daysAgo(92),
      payment_method_id: soles.id, partner_name: "Ana Socia Demo" }, where(pinos)));
    api("addPartnerMoney", Object.assign({ direction: "in", kind: "contribution", amount: 45000, currency: "PEN", date: daysAgo(88),
      payment_method_id: soles.id, partner_name: "Pedro Socio Demo" }, where(pinos)));
    waiting_({ id: "demo-distribution", type: "expense", date: daysAgo(12), amount: 7600, currency: "PEN", category_id: materials,
      description: "Distribución utilidades Casa Las Flores", payment_method_id: soles.id, paid_by: "me", status: "pending", source: "email" });
    api("recordDistribution", { entry_id: "demo-distribution", partner_name: "Ana Socia Demo", withholding: 400 });

    // Lenders: two private loans to the building, paid monthly; the installments already paid carry SUNAT's withholding.
    const schedule = (total, n, rate, firstAgo) => Array.from({ length: n }, (_, i) => ({
      due_date: i * 30 < firstAgo ? daysAgo(firstAgo - i * 30) : monthsAhead(Math.ceil((i * 30 - firstAgo) / 30) + 1, 10),
      principal: Math.round((total / n) * 100) / 100, interest: Math.round(total * rate * (n - i) / n * 100) / 100, fees: 0 }));
    const lend = (name, amount, currency, account, ago) => api("saveBankLoan", Object.assign({ friend_name: name, amount, currency, date: daysAgo(ago),
      payment_method_id: account, description: "Préstamo " + name, installments: schedule(amount, 12, 0.012, ago - 30), lender: true }, where(pinos)));
    const loanA = lend("Inversiones Demo EIRL", 120000, "PEN", soles.id, 95);
    const loanB = lend("Carmen Prestamista Demo", 30000, "USD", dolares.id, 70);
    [[loanA, soles.id, 2], [loanB, dolares.id, 1]].forEach(([loan, account, paid]) => {
      for (let i = 0; i < paid; i++) {
        const inst = loan.installments[i];
        api("recordInstallment", { id: inst.id, date: inst.due_date, payment_method_id: account, withholding: Math.round(Number(inst.interest) * 0.05 * 100) / 100, category_id: interest });
      }
    });

    // Everyday costs of the building over ~3 months (soles mostly, a few in dollars), and a few for the finished house.
    const suppliers = [["Ferretería Demo", materials, 900, 6500], ["Cementos Demo SAC", materials, 2500, 14000], ["Planilla obra", labor, 3000, 9000],
      ["Estudio de diseño Demo", design, 1500, 5000], ["Notaría Demo", notary, 300, 1800]];
    for (let day = 90; day >= 2; day -= 2) {
      const [desc, category, lo, hi] = suppliers[Math.floor(rnd() * suppliers.length)];
      const usd = rnd() < 0.15;
      api("createEntry", Object.assign({ type: "expense", date: daysAgo(day), amount: usd ? between(lo / 3.7, hi / 3.7) : between(lo, hi), currency: usd ? "USD" : "PEN",
        category_id: category, description: desc, payment_method_id: usd ? dolares.id : soles.id, paid_by: "me" }, where(rnd() < 0.65 ? pinos : rnd() < 0.8 ? miraflores : flores)));
    }
    for (let m = 0; m < 3; m++) {
      api("createEntry", Object.assign({ type: "expense", date: daysAgo(5 + 30 * m), amount: 45, currency: "PEN", category_id: fees, description: "Mantenimiento de cuenta",
        payment_method_id: soles.id, paid_by: "me" }, where(pinos)));
    }

    // Needs review: what the bank e-mails would have left waiting (no company yet; the copy puts them on its only company).
    [["Ferretería Demo", 1240.5, materials, 1], ["Cementos Demo SAC", 8900, materials, 0], ["Comisión transferencia", 12, fees, 0], ["Planilla obra", 6200, labor, 2]]
      .forEach(([desc, amount, category, ago], i) => waiting_({ id: "demo-review-" + i, type: "expense", date: daysAgo(ago), amount, currency: "PEN",
        category_id: category, description: desc, payment_method_id: soles.id, paid_by: "me", status: "pending", source: "email" }));
    return { company: company.id };
  }

  const out = { seed };
  if (typeof module === "object" && module.exports) module.exports = out;
  else root.DemoSeed = out;
})(typeof self !== "undefined" ? self : globalThis);
