// Business 2, piece 5: units as tags ("Add units") and the bots' short format on a company copy (CompanyBot.gs, TypedEntry.gs).
// Made-up data only, on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { freshApp } = require("./helpers");

function companyCopy(lang = "es") {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.run(`setSetting_('language', '${lang}')`);
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  const floors = [];
  for (let f = 1; f <= 8; f++) for (let u = 1; u <= 5; u++) floors.push("Depa " + (f * 100 + u));
  rt.api("addTagsBulk", { names: floors.concat(["Depa 3", "Tienda 1", "300"]) });
  rt.api("addFriend", { name: "Ana Pérez", role: "client" });
  return rt;
}
// Saves a typed line the way both bots do (the shared reader) and returns { r, entry, tags }.
function say(rt, text, n = Math.random()) {
  rt.ctx.__p = JSON.stringify({ id: "msg-" + n, text, timestamp: Math.floor(Date.now() / 1000) });
  const r = JSON.parse(JSON.stringify(rt.run("newTypedEntry_(JSON.parse(__p), 'whatsapp')")));
  const entry = r.entry ? rt.rows("Entries").find((e) => e.id === r.entry.id) : null;
  const tagNames = entry ? rt.rows("Entry Tags").filter((et) => et.entry_id === entry.id).map((et) => rt.rows("Tags").find((t) => t.id === et.tag_id).name) : [];
  return { r, entry, tags: tagNames };
}
const catName = (rt, id) => { const c = rt.rows("Categories").find((x) => x.id === id); return c ? c.name : ""; };
// The payer of an income: a person (people merged into one list) or a row of the older Payors tab.
const person = (rt, id) => { const f = rt.rows("Friends").find((x) => x.id === id) || (rt.sheet("Payors") ? rt.rows("Payors").find((x) => x.id === id) : null); return f ? f.name : ""; };

test("Add units: many tags at once, existing names skipped", () => {
  const rt = companyCopy();
  assert.ok(rt.rows("Tags").some((t) => t.name === "Depa 805"));
  const again = rt.api("addTagsBulk", { names: ["Depa 805", "depa 805", "Cochera 12"] });
  assert.equal(again.added, 1);
  assert.equal(again.skipped, 2);
  assert.throws(() => rt.api("addTagsBulk", { names: Array.from({ length: 301 }, (_, i) => "U" + i) }), /300/);
});

test("the plan's examples read the same, in any order", () => {
  const rt = companyCopy();
  let s = say(rt, "ingreso 30000 separación depa 3 Pérez");
  assert.equal(s.entry.type, "income");
  assert.equal(Number(s.entry.amount), 30000);
  assert.equal(s.entry.currency, "PEN");
  assert.equal(catName(rt, s.entry.category_id), "Reservation deposits");
  assert.deepEqual(s.tags, ["Depa 3"]);
  assert.equal(person(rt, s.entry.paid_by), "Ana Pérez", "an existing client by her last name");
  assert.equal(s.entry.status, "pending", "it waits in Needs review");
  assert.equal(s.entry.company_id, rt.rows("Companies")[0].id, "with the company (piece 2)");
  assert.match(s.r.reply, /Entendí: ingreso de .*30,?000\.00 · Separaciones · Depa 3 · cliente Ana Pérez/);

  s = say(rt, "depa 3 ingreso 30000 Pérez");
  assert.equal(Number(s.entry.amount), 30000);
  assert.equal(s.entry.category_id, "", "no concept: the category is picked in Needs review");
  assert.match(s.r.reply, /Sin concepto/);

  s = say(rt, "+30 mil 805 separación Pérez");
  assert.equal(s.entry.type, "income");
  assert.equal(Number(s.entry.amount), 30000);
  assert.deepEqual(s.tags, ["Depa 805"]);

  s = say(rt, "cobré $5000 inicial dpto 805 Pérez");
  assert.equal(s.entry.currency, "USD");
  assert.equal(Number(s.entry.amount), 5000);
  assert.equal(catName(rt, s.entry.category_id), "Down payments");
  assert.deepEqual(s.tags, ["Depa 805"]);

  s = say(rt, "ingreso 30k saldo depa 101 Pérez");
  assert.equal(Number(s.entry.amount), 30000);
  assert.equal(catName(rt, s.entry.category_id), "Sale balances");
  s = say(rt, "ingreso 30,000 separación Tienda 1 Pérez");
  assert.equal(Number(s.entry.amount), 30000);
  assert.deepEqual(s.tags, ["Tienda 1"]);
});

test("a new client in an income is added with the client role, a two-word name included; the reply says so", () => {
  const rt = companyCopy();
  const s = say(rt, "ingreso 12000 separación depa 202 Luis Quispe");
  const friend = rt.rows("Friends").find((f) => f.name === "Luis Quispe");
  assert.ok(friend);
  assert.equal(friend.role, "client");
  assert.equal(person(rt, s.entry.paid_by), "Luis Quispe");
  assert.match(s.r.reply, /cliente Luis Quispe \(nuevo/);
});

test("when it cannot tell, it asks; a unit that does not exist stays in the description and the reply says so", () => {
  const rt = companyCopy();
  const before = rt.rows("Entries").length;
  const ask = say(rt, "ingreso 805 300 Pérez");
  assert.equal(ask.r.saved, false);
  assert.match(ask.r.reply, /¿Cuál es el monto: 805 o 300\?/);
  assert.equal(rt.rows("Entries").length, before, "nothing saved");
  const s = say(rt, "ingreso 4000 separación depa 999 Pérez");
  assert.equal(Number(s.entry.amount), 4000);
  assert.deepEqual(s.tags, []);
  assert.match(s.entry.description, /depa 999/i);
  assert.match(s.r.reply, /No hay una unidad llamada "depa 999"/);
});

test("ordinary lines and the long form still work on a company copy; a normal copy never reads the short format", () => {
  const rt = companyCopy();
  let s = say(rt, "25 almuerzo");
  assert.equal(s.entry.type, "expense");
  assert.equal(Number(s.entry.amount), 25);
  assert.equal(s.entry.description, "Almuerzo");
  s = say(rt, "500 cemento depa 3");
  assert.equal(s.entry.type, "expense");
  assert.equal(Number(s.entry.amount), 500);
  assert.deepEqual(s.tags, ["Depa 3"]);
  s = say(rt, "300 pintura, etiqueta Tienda 1");
  assert.deepEqual(s.tags, ["Tienda 1"], "the long form with its comma keyword");
  // a friend's copy: "805" is never a unit, the usual reading
  const { rt: plain } = freshApp({ small: true });
  plain.svc.props.set("FEATURES", "base");
  plain.api("addTag", { name: "Depa 3" });
  const p = say(plain, "ingreso 30000 separación depa 3 Pérez");
  assert.equal(Number(p.entry.amount), 30000, "the usual reading: the number right after \"ingreso\"");
  assert.deepEqual(p.tags, [], "no unit outside a company copy");
  assert.match(p.entry.description, /depa 3/i);
});

test("help names the short format on a company copy only; the phone has Add units; app.js loads", () => {
  const rt = companyCopy();
  assert.match(rt.run("tr_('coBot.help')"), /cualquier orden/);
  const src = fs.readFileSync(path.join(__dirname, "../../backend/WhatsAppBot.gs"), "utf8");
  assert.equal((src.match(/isCompanyCopy_\(\) \? '\\n\\n' \+ tr_\('coBot\.help'\)/g) || []).length, 2, "both bots");
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(app));
  assert.match(app, /callApi\("addTagsBulk"/);
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  assert.match(html, /id="units-add-btn"/);
});

test("both bots show the notes under the transaction's own message: a new client, a unit that does not exist, no concept", () => {
  const rt = companyCopy();
  const a = say(rt, "ingreso 12000 separación depa 202 Rosa Lima");
  assert.match(a.r.editMessage, /Rosa Lima es un cliente nuevo/);
  const b = say(rt, "ingreso 4000 depa 999 Pérez");
  assert.match(b.r.editMessage, /No hay una unidad llamada "depa 999"/);
  assert.match(b.r.editMessage, /Sin concepto/);
  assert.equal(say(rt, "ingreso 30000 separación depa 3 Pérez").r.editMessage, "", "nothing to add: the card says it all");
  assert.deepEqual(say(rt, "ingreso 9000 separación unit 805 Pérez").tags, ["Depa 805"], "English help's \"unit 805\"");
});
