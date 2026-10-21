// Telegram: what the bot TELLS the person to type must be exactly what it understands (owner's request 2026-10-21, after "payment method"
// became "account"). Every quoted command in the help and in the "reply …" hints is fed to the real parser, in both languages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, linkTelegram } = require("./helpers");

const gsSrc = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "Strings.gs"), "utf8");

// { key, lang, example } for every quoted command in the bot's own texts
function commandExamples() {
  const out = [];
  for (const line of gsSrc.split("\n")) {
    const m = /^\s*"([\w.]+)": \{ en: (.*?), es: (.*?)\s?\},?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!/^(help\.|bot\.(notSet|blocker|need|tripWillLink|transferNoEnds|internalTransfer))/.test(key) || key === "help.bothLanguages") continue;
    for (const [lang, raw] of [["en", m[2]], ["es", m[3]]]) {
      for (const q of raw.matchAll(/\\"(.+?)\\"/g)) out.push({ key, lang, example: q[1] });
    }
  }
  return out;
}

test("the bot's texts quote commands, and there are many (so the check below means something)", () => {
  const ex = commandExamples();
  assert.ok(ex.length > 60, `found ${ex.length}`);
  assert.ok(ex.some((e) => e.example === "account Interbank" && e.lang === "en"));
  assert.ok(ex.some((e) => e.example === "cuenta Interbank" && e.lang === "es"));
});

test("every command the help and the hints quote is understood by the parser, in English and in Spanish", () => {
  const { rt } = freshApp({ small: true });
  const understood = (example) => rt.run(`(function (ex) {
    return splitEditCommands_(ex).every(function (seg) {
      return EDIT_COMMAND_PATTERNS.some(function (p) { return p.re.test(seg); }) ||
        /^(?:(?:mark\\s+as|marcar\\s+como)\\s+)?(?:repayment|repago)\\s+(.+)/i.test(seg) ||
        /^(?:(?:convert\\s+to|convertir\\s+en)\\s+)?(?:loan|pr[eé]stamo)\\s+(.+)/i.test(seg);
    });
  })(${JSON.stringify(example)})`);
  const bad = commandExamples().filter((e) => /\s/.test(e.example) || /^(withdrawal|deposit|retiro|dep[oó]sito)$/i.test(e.example)).filter((e) => !understood(e.example));
  assert.deepEqual(bad.map((e) => `${e.key} (${e.lang}): "${e.example}"`), []);
});

test("the Spanish help speaks Spanish: 'cuenta', 'recibido en' — and none of the bot's texts says 'payment method' / 'medio de pago' / 'la tarjeta'", () => {
  const texts = commandExamples().map((e) => e.example).join("\n");
  assert.ok(!/payment method|medio de pago/i.test(gsSrc.split("\n").filter((l) => /^\s*"(help|bot)\./.test(l)).join("\n")));
  assert.ok(!/Responde a la tarjeta|Reply to the card/.test(gsSrc));
  assert.ok(/recibido en Interbank/.test(texts) && /received in Interbank/.test(texts));
});

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  rt.run(`appendRowObject('Telegram Messages', { message_id: '700', entry_id: ${JSON.stringify(pending.id)}, created_at: 'x' });`);
  let n = 0;
  const reply = (text) => rt.rawPost(JSON.stringify({ update_id: 9000 + (++n), message: { chat: { id: chat }, message_id: 900 + n, text, reply_to_message: { message_id: 700 } } }));
  const entry = () => rt.rows("Entries").find((e) => e.id === pending.id);
  return { rt, data, reply, entry };
}

test("'account' / 'cuenta' work inside a combined reply (the comma before them starts a new command)", () => {
  const { rt, data, reply, entry } = setup();
  const pm = data.pms.filter((p) => p.type !== "investment")[2];
  reply(`category groceries, account ${pm.nickname}, amount 12.50`);
  const e = entry();
  assert.equal(e.payment_method_id, pm.id);
  assert.equal(Number(e.amount), 12.5);
  assert.equal(e.category_id, rt.rows("Categories").find((c) => c.name === "Groceries" && c.type === "expense").id);
  const pm2 = data.pms.filter((p) => p.type !== "investment")[3];
  reply(`categoría restaurantes, cuenta ${pm2.nickname}`);
  assert.equal(entry().payment_method_id, pm2.id);
});

test("a description that contains a comma and the word 'cuenta' is only torn when 'cuenta' starts a command", () => {
  const { rt } = freshApp({ small: true });
  const parts = (t) => JSON.parse(rt.run(`JSON.stringify(splitEditCommands_(${JSON.stringify(t)}))`));
  assert.deepEqual(parts("description Rent, September"), ["description Rent, September"]);
  assert.deepEqual(parts("category groceries, cuenta Interbank"), ["category groceries", "cuenta Interbank"]);
  assert.deepEqual(parts("withdrawal, platform Hapi, received in Interbank"), ["withdrawal", "platform Hapi", "received in Interbank"]);
});
