// The journeys' outside world (tests/harness/channels.js): every bank e-mail template is read by the REAL rules, an e-mail waits for
// its moment, and the fake Telegram / WhatsApp chats reach the real bots. Every value is made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");
const channels = require("../harness/channels");
const fs = require("fs");
const path = require("path");
// The e-mail rule pack a real copy downloads (some kinds, like Interbank's "pago recurrente", are read only by the pack).
const withPack = (rt) => rt.api("setRulePack", { text: fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8") });

const fromEmail = (rt) => rt.rows("Entries").filter((e) => e.source === "email");

test("every readable bank e-mail template becomes a waiting entry with its amount", () => {
  const { rt } = freshApp({ entries: 300 });
  withPack(rt);
  const world = channels.attach(rt);
  const readable = Object.keys(channels.BANK_MAIL).filter((k) => !/^(bbva|scotiabank)_/.test(k));
  readable.forEach((kind, i) => world.queueMail([{ kind, amount: 10 + i + 0.25, merchant: "PRUEBA " + kind.toUpperCase(), last4: "1234" }]));
  const before = fromEmail(rt).length;
  const res = JSON.parse(JSON.stringify(rt.run("processEmails()")));
  assert.equal(res.unparsed, 0, JSON.stringify(res.unparsedSubjects));
  const made = fromEmail(rt).slice(before);
  readable.forEach((kind, i) => {
    assert.ok(made.some((e) => Math.abs(Number(e.amount) - (10 + i + 0.25)) < 0.001), kind + " was not read");
  });
});

test("banks with no rule yet (BBVA, Scotiabank) make no entry", () => {
  const { rt } = freshApp({ entries: 300 });
  const world = channels.attach(rt);
  world.queueMail([{ kind: "bbva_purchase", amount: 33.3, merchant: "X" }, { kind: "scotiabank_purchase", amount: 44.4, merchant: "Y" }]);
  const before = fromEmail(rt).length;
  rt.run("processEmails()");
  assert.equal(fromEmail(rt).length, before);
});

test("an e-mail for a later moment waits in the queue until then", () => {
  const { rt } = freshApp({ entries: 300 });
  const world = channels.attach(rt);
  const later = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
  const delivered = world.queueMail([{ kind: "bcp_debit", amount: 5, merchant: "LATER", at: Date.now() + 2 * 86400000 }]);
  assert.equal(delivered, 0);
  assert.equal(world.mailQueue.length, 1, later);
});

test("the fake Telegram chat reaches the real bot and shows its answer", () => {
  const { rt } = freshApp({ entries: 300 });
  const world = channels.attach(rt);
  linkTelegram(rt, Number(world.TG_CHAT));
  world.telegramSend({ text: "25 almuerzo" });
  const answers = world.chat.filter((c) => c.who === "bot");
  assert.ok(answers.length >= 1, "the bot answered");
});

test("the fake WhatsApp chat reaches the real bot once the person turned it on", () => {
  const { rt } = freshApp({ entries: 300 });
  const world = channels.attach(rt);
  world.whatsappOffer();
  rt.api("turnOnWhatsAppBot", { number: "51900000001" });
  world.whatsappSend({ text: "18.50 taxi" });
  assert.ok(world.chat.some((c) => c.who === "bot" && !/relay fallback/.test(c.text)), JSON.stringify(world.chat));
});
