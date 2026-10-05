// Generates a large, entirely MADE-UP dataset (deterministic: same seed, same
// data) so the fake backend is about as heavy as the real sheet — loading
// times then say something real. Nothing here comes from the owner's data.
const crypto = require("crypto");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  seed: 42, entries: 7000, months: 36, friends: 18, loans: 350, recurring: 25
};

const MERCHANTS = ["Market Fresh", "Corner Cafe", "City Fuel", "Metro Ride", "Green Pharmacy", "Pixel Store",
  "Book Nook", "Pizza Place", "Sushi Bar", "Streamly", "Fit Gym", "Home Depot Lite", "Taxi Go", "Bakery 24", "Cinema One"];
const FRIEND_NAMES = ["Ana Lo", "Ben Ray", "Eva Ray", "Carlos Vega", "Dana Mora", "Elio Paz", "Fiona Gil", "Gus Rey",
  "Hana Sol", "Ivo Luna", "Jade Cruz", "Kai Ortiz", "Lia Soto", "Milo Diaz", "Nora Vela", "Omar Lin", "Pia Roca", "Quin Bel"];

function seedData(rt, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const rnd = mulberry32(o.seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const uuid = () => crypto.randomUUID();
  const money = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
  const ymd = (d) => d.toISOString().slice(0, 10);

  // Appends objects to a sheet in one go, aligned to the sheet's own header row.
  function bulk(name, objs) {
    const sheet = rt.sheet(name);
    const headers = sheet.rows[0];
    const rows = objs.map((ob) => headers.map((h) => (ob[h] !== undefined ? ob[h] : "")));
    sheet._write(sheet.rows.length + 1, 1, rows);
  }

  const cats = rt.rows("Categories");
  const byType = (t) => cats.filter((c) => c.type === t);
  const expenseCats = byType("expense"), incomeCats = byType("income");
  const transferCat = byType("transfer")[0], investCats = byType("investment");
  const banks = rt.rows("Banks");

  // Payment methods
  const pmDefs = [["Cash", "cash", null], ["Yape", "wallet", "Yape"], ["Plin", "wallet", "Plin"],
    ["Main debit", "debit", "BCP"], ["Savings", "debit", "BCP"], ["Daily debit", "debit", "Interbank"],
    ["Travel card", "credit", "Interbank"], ["Shop card", "credit", "Diners"], ["BCP card", "credit", "BCP"],
    ["Invest account", "debit", "SIP"], ["Wallet B", "wallet", "Yape"], ["Backup debit", "debit", "Interbank"]];
  const pms = pmDefs.map(([nickname, type, bank]) => ({
    id: uuid(), nickname, type, bank_id: bank ? banks.find((b) => b.name === bank).id : "",
    last_4: type === "cash" ? "" : String(1000 + Math.floor(rnd() * 8999))
  }));
  bulk("Payment Methods", pms);
  const spendPms = pms.filter((p) => p.type !== "wallet" || rnd() < 0.5);

  // Friends & payors
  const friends = FRIEND_NAMES.slice(0, o.friends).map((name) => ({ id: uuid(), name, notes: "" }));
  rt.sheet("Friends").rows.length = 1;
  bulk("Friends", friends);
  const payors = ["Acme Co", "Globex Ltd", "Initech", "Freelance A"].map((name) => ({ id: uuid(), name, notes: "" }));
  bulk("Payors", payors);

  // Exchange rates: monthly, 3 currencies, slow drift
  const today = new Date();
  const months = [];
  for (let i = o.months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const base = { USD: 3.7, EUR: 4.0, CLP: 0.0041 };
  const rates = [];
  months.forEach((m, i) => Object.keys(base).forEach((cur) => {
    rates.push({ id: uuid(), month: m, currency: cur, rate: Math.round(base[cur] * (1 + 0.01 * Math.sin(i / 3) + 0.002 * i) * 10000) / 10000 });
  }));
  bulk("Exchange Rates", rates);

  // Tags
  const tags = ["Work", "Trip", "Gift", "Health", "Kids"].map((name) => ({ id: uuid(), name, color: "#cccccc" }));
  bulk("Tags", tags);

  // Entries
  const entries = [], entryTags = [], splits = [], loans = [], settlements = [], tgMsgs = [];
  const startMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - o.months + 1, 1);
  const spanMs = today.getTime() - startMs;
  for (let i = 0; i < o.entries; i++) {
    const d = new Date(startMs + rnd() * spanMs);
    const date = ymd(d);
    const r = rnd();
    const e = {
      id: uuid(), date, status: "confirmed", source: "manual", paid_by: "me", currency: "PEN",
      created_at: date + "T" + String(Math.floor(rnd() * 24)).padStart(2, "0") + ":" + String(Math.floor(rnd() * 60)).padStart(2, "0") + ":00",
      description: pick(MERCHANTS), merchant: pick(MERCHANTS).toLowerCase(), external_id: "", import_batch_id: ""
    };
    e.updated_at = e.created_at;
    if (r < 0.84) {
      e.type = "expense"; e.category_id = pick(expenseCats).id; e.amount = money(3, 280);
      e.payment_method_id = pick(spendPms).id;
      if (rnd() < 0.06) { e.currency = pick(["USD", "EUR", "CLP"]); e.amount = e.currency === "CLP" ? Math.round(money(2000, 60000)) : money(5, 120); }
      if (rnd() < 0.15) { e.source = "email"; e.external_id = uuid(); }
    } else if (r < 0.92) {
      e.type = "income"; e.category_id = pick(incomeCats).id; e.amount = money(300, 6000);
      e.paid_by = pick(payors).id; e.payment_method_id = pick(pms.filter((p) => p.type === "debit")).id; e.description = "Payment";
    } else if (r < 0.96) {
      e.type = "transfer"; e.category_id = transferCat ? transferCat.id : ""; e.amount = money(50, 2000);
      const a = pick(pms), b = pick(pms); e.payment_method_id = a.id; e.to_payment_method_id = b.id; e.description = "Own transfer";
    } else if (r < 0.98) {
      e.type = "investment"; e.category_id = investCats.length ? pick(investCats).id : ""; e.amount = money(100, 3000);
      e.payment_method_id = pick(pms).id; e.to_payment_method_id = pms[9].id; e.description = "Deposit";
    } else {
      e.type = "expense"; e.category_id = ""; e.amount = money(5, 90); e.status = "pending"; e.source = "email";
      e.external_id = uuid(); e.payment_method_id = pick(spendPms).id;
      tgMsgs.push({ message_id: 100000 + i, entry_id: e.id, created_at: e.created_at });
    }
    entries.push(e);
    if (e.type === "expense" && e.status === "confirmed" && rnd() < 0.4) {
      entryTags.push({ entry_id: e.id, tag_id: pick(tags).id });
    }
  }

  // Shared expenses -> splits + entry-origin loans, some repaid / forgiven
  const sharable = entries.filter((e) => e.type === "expense" && e.status === "confirmed" && e.currency === "PEN" && e.amount > 40);
  for (let i = 0; i < o.loans && i < sharable.length; i++) {
    const e = sharable[i * 3 % sharable.length];
    if (e.__loan) continue; e.__loan = true;
    const f = pick(friends);
    const share = Math.round(e.amount * (0.2 + rnd() * 0.4) * 100) / 100;
    splits.push({ id: uuid(), entry_id: e.id, friend_id: f.id, amount: share });
    const loan = { id: uuid(), friend_id: f.id, direction: "they_owe_me", origin: "entry", entry_id: e.id, amount: share,
      currency: "PEN", date: e.date, due_date: "", payment_method_id: "", description: e.description, status: "outstanding", transfer_entry_id: "" };
    const roll = rnd();
    if (roll < 0.45) {
      settlements.push({ id: uuid(), loan_id: loan.id, date: e.date, amount: share, payment_method_id: pick(pms).id, offset_loan_id: "", transfer_entry_id: "" });
      loan.status = "repaid";
    } else if (roll < 0.6) {
      const part = Math.round(share * 0.4 * 100) / 100;
      settlements.push({ id: uuid(), loan_id: loan.id, date: e.date, amount: part, payment_method_id: pick(pms).id, offset_loan_id: "", transfer_entry_id: "" });
      loan.status = "partially_repaid";
    }
    loans.push(loan);
  }
  entries.forEach((e) => delete e.__loan);

  bulk("Entries", entries);
  bulk("Entry Tags", entryTags);
  bulk("Entry Splits", splits);
  bulk("Loans", loans);
  bulk("Settlements", settlements);
  bulk("Telegram Messages", tgMsgs);

  // Budgets (monthly, a dozen categories)
  bulk("Budgets", expenseCats.slice(0, 12).map((c) => ({
    id: uuid(), category_id: c.id, amount: money(200, 1500), currency: "PEN", period_type: "monthly", thresholds: "75,100", name: ""
  })));

  // Programmed items
  bulk("Recurring Expenses", Array.from({ length: o.recurring }, (_, i) => ({
    id: uuid(), category_id: pick(expenseCats).id, description: "Programmed " + (i + 1), amount: money(20, 900), currency: "PEN",
    frequency: pick(["monthly", "monthly", "yearly"]), day: 1 + Math.floor(rnd() * 28), month: 1 + Math.floor(rnd() * 12), active: true, date: ""
  })));

  return { friends, pms, payors, tags, cats, entries, loans, splits, settlements, months };
}

module.exports = { seedData };
