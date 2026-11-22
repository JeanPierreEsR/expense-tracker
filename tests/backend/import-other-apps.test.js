// Other money apps' exports, read by their column words (docs/statement-table.js). Made-up rows in each app's documented layout
// (journeys run, 2026-11-17: a Money Manager file was read as all income, with no accounts). Layouts checked on 2026-11-17:
// Money Manager (Realbyte) "Income/Expense" = "Exp." / "Income"; YNAB register Outflow / Inflow; Mint "Transaction Type" = debit /
// credit; Bluecoins' template (Type, Date, Item or Payee, Amount, Parent Category, Category, Account Type, Account, Notes…).
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../../docs/statement-table.js");

const read = (rows) => { const m = T.guessMapping(rows); return { m, r: T.applyMapping(rows, m) }; };
const out = (r) => Math.round(r.lines.filter((l) => l.amount < 0).reduce((t, l) => t - l.amount, 0) * 100) / 100;
const inn = (r) => Math.round(r.lines.filter((l) => l.amount > 0).reduce((t, l) => t + l.amount, 0) * 100) / 100;

test("Money Manager: 'Exp.' is spending, 'Income' is income, and the first 'Accounts' column (names) is the account", () => {
  const { m, r } = read([
    ["Period", "Accounts", "Category", "Subcategory", "Note", "PEN", "Income/Expense", "Description", "Amount", "Currency", "Accounts"],
    ["11/14/2026 13:22:05", "Interbank 0001", "Food", "", "Bodega Prueba", 12.5, "Exp.", "", 12.5, "PEN", 12.5],
    ["11/15/2026 09:00:00", "Card 0002", "Transport", "", "Taxi Prueba", 8, "Exp.", "", 8, "PEN", 8],
    ["11/28/2026 08:00:00", "Interbank 0001", "Salary", "", "Pay Prueba", 3000, "Income", "", 3000, "PEN", 3000]
  ]);
  assert.equal(m.account, 1, "the column of names, not the last one of amounts");
  assert.equal(m.type, 6);
  assert.equal(out(r), 20.5);
  assert.equal(inn(r), 3000);
  assert.deepEqual(r.lines.map((l) => l.account), ["Interbank 0001", "Card 0002", "Interbank 0001"]);
});

test("YNAB: Outflow and Inflow are the two money columns", () => {
  const { m, r } = read([
    ["Account", "Flag", "Date", "Payee", "Category Group/Category", "Category Group", "Category", "Memo", "Outflow", "Inflow", "Cleared"],
    ["Checking Prueba", "", "11/03/2026", "Market Prueba", "Everyday: Groceries", "Everyday", "Groceries", "", "45.10", "0.00", "Cleared"],
    ["Checking Prueba", "", "11/04/2026", "Employer Prueba", "Inflow: Ready to Assign", "Inflow", "Ready to Assign", "", "0.00", "2000.00", "Cleared"]
  ]);
  assert.ok(m.out >= 0 && m.in >= 0);
  assert.equal(out(r), 45.1);
  assert.equal(inn(r), 2000);
  assert.equal(r.lines[0].description, "Market Prueba");
});

test("Mint: 'debit' is spending and 'credit' is income in the Transaction Type column", () => {
  const { r } = read([
    ["Date", "Description", "Original Description", "Amount", "Transaction Type", "Category", "Account Name", "Labels", "Notes"],
    ["11/05/2026", "Coffee Prueba", "COFFEE PRUEBA 123", "4.50", "debit", "Coffee Shops", "Card Prueba", "", ""],
    ["11/06/2026", "Refund Prueba", "REFUND PRUEBA", "10.00", "credit", "Shopping", "Card Prueba", "", ""]
  ]);
  assert.equal(out(r), 4.5);
  assert.equal(inn(r), 10);
  assert.equal(r.lines[0].account, "Card Prueba");
});

test("Bluecoins: Type says expense or income; 'Item or Payee' is the description; 'Account', not 'Account Type', is the account", () => {
  const { m, r } = read([
    ["Type", "Date", "Item or Payee", "Amount", "Parent Category", "Category", "Account Type", "Account", "Notes", "Label", "Status"],
    ["Expense", "2026-11-07", "Pharmacy Prueba", "30", "Health", "Medicine", "Bank", "Savings Prueba", "", "", ""],
    ["Income", "2026-11-08", "Client Prueba", "500", "Work", "Freelance", "Bank", "Savings Prueba", "", "", ""]
  ]);
  assert.equal(m.account, 7);
  assert.equal(out(r), 30);
  assert.equal(inn(r), 500);
  assert.equal(r.lines[0].description, "Pharmacy Prueba");
});

test("short type words in Spanish and English", () => {
  for (const w of ["Exp.", "exp", "Gasto", "Gto.", "Egr.", "debit"]) assert.equal(T.typeKind(w), "expense", w);
  for (const w of ["Income", "Inc.", "Ing.", "Ingreso", "credit"]) assert.equal(T.typeKind(w), "income", w);
});

test("Wallet's 'Restaurant, fast-food' and 'Bar, cafe' land in Restaurants, and 'Taxi' in Transport (journeys run, 2026-11-17)", () => {
  const { freshApp } = require("./helpers");
  const { rt } = freshApp({ entries: 10 });
  const res = rt.api("suggestCategoryMap", { names: [{ type: "expense", name: "Restaurant, fast-food", count: 3 }, { type: "expense", name: "Bar, cafe", count: 1 }, { type: "expense", name: "Taxi", count: 2 }] });
  const cats = JSON.parse(rt.run("JSON.stringify(getAllRows('Categories'))"));
  const keyOf = (id) => (cats.find((c) => c.id === id) || {}).key;
  const by = Object.fromEntries(res.items.map((it) => [it.name, it]));
  for (const n of ["Restaurant, fast-food", "Bar, cafe"]) { assert.equal(by[n].action, "match", n); assert.equal(keyOf(by[n].categoryId), "restaurants", n); }
  assert.equal(by["Taxi"].action, "match");
  assert.equal(keyOf(by["Taxi"].categoryId), "transport");
});
