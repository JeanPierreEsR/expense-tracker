// "Remind on WhatsApp" on a person's loan screen (specs/loans.md § Reminders): the message (docs/loan-reminder.js) and the friend's
// remembered number (setFriendPhone). Made-up names and amounts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I18n = require("../../docs/i18n.js");
const R = require("../../docs/loan-reminder.js");
const { freshApp } = require("./helpers");

const loan = (o) => Object.assign({ status: "open", origin: "cash", description: "", date: "2026-10-12" }, o);

test("the message lists what they owe, newest first, with the total per currency (never converted)", () => {
  I18n.setLang("en");
  const text = R.build({
    name: "Ana Test",
    today: "2026-11-02",
    loans: [
      loan({ direction: "they_owe_me", currency: "PEN", remaining: 85, description: "Dinner", date: "2026-10-12" }),
      loan({ direction: "they_owe_me", currency: "USD", remaining: 20, origin: "entry", date: "2026-10-18" }),
      loan({ direction: "they_owe_me", currency: "PEN", remaining: 0, description: "Paid already" }),
      loan({ direction: "they_owe_me", currency: "PEN", remaining: 40, status: "forgiven", description: "Forgiven one" })
    ]
  });
  const lines = text.split("\n");
  assert.match(lines[0], /^Hi Ana 👋/);
  assert.equal(lines[2], "• Shared expense (Oct 18): US$ 20.00");
  assert.equal(lines[3], "• Dinner (Oct 12): S/ 85.00");
  assert.ok(text.includes("In total you owe me S/ 85.00 and US$ 20.00."));
  assert.ok(!/Paid already|Forgiven one|takes off/.test(text));
});

test("what I owe them is taken off; a currency where I owe more is left out; nothing owed = no reminder", () => {
  I18n.setLang("es");
  const loans = [
    loan({ direction: "they_owe_me", currency: "PEN", remaining: 100, description: "Cine", date: "2025-12-30" }),
    loan({ direction: "i_owe_them", currency: "PEN", remaining: 30 }),
    loan({ direction: "they_owe_me", currency: "USD", remaining: 10, description: "Taxi" }),
    loan({ direction: "i_owe_them", currency: "USD", remaining: 25 })
  ];
  const text = R.build({ name: "Bo", today: "2026-11-02", loans });
  assert.match(text, /^Hola Bo 👋/);
  assert.ok(text.includes("• Cine (30 dic 2025): S/ 100.00"), "another year shows the year");
  assert.ok(text.includes("En total me debes S/ 70.00."));
  assert.ok(text.includes("Ya está descontado lo que yo te debo"));
  assert.ok(!text.includes("Taxi") && !text.includes("US$"), "USD: I owe more, so it is not mentioned");
  assert.equal(R.canRemind(loans), true);
  assert.equal(R.canRemind([loan({ direction: "i_owe_them", currency: "PEN", remaining: 5 })]), false);
  assert.equal(R.build({ name: "Bo", today: "2026-11-02", loans: [] }), "");
  I18n.setLang("en");
});

test("at most five debts are listed, then '… and N more'", () => {
  I18n.setLang("en");
  const loans = Array.from({ length: 8 }, (_, i) => loan({ direction: "they_owe_me", currency: "PEN", remaining: 1, description: "Item " + i, date: `2026-10-0${i + 1}` }));
  const text = R.build({ name: "Cy", today: "2026-11-02", loans });
  assert.equal((text.match(/^• /gm) || []).length, R.MAX_ITEMS);
  assert.ok(text.includes("• Item 7 (Oct 8)"), "newest first");
  assert.ok(text.includes("… and 3 more"));
  assert.ok(text.includes("In total you owe me S/ 8.00."));
});

test("the WhatsApp link carries the edited text and the number as digits", () => {
  assert.equal(R.whatsappUrl("+51 987-654-321", "Hi & bye", true), "whatsapp://send?phone=51987654321&text=Hi%20%26%20bye");
  assert.equal(R.whatsappUrl("", "Hi", true), "whatsapp://send?text=Hi");
  assert.equal(R.whatsappUrl("+51 987 654 321", "Hi\nThere", false), "https://wa.me/51987654321?text=Hi%0AThere");
  assert.equal(R.phoneOk("+51 987 654 321"), true);
  assert.equal(R.phoneOk("12"), false);
});

test("every reminder text exists in both languages", () => {
  const S = require("../../docs/strings.js");
  const keys = Object.keys(S).filter((k) => k.startsWith("remind."));
  assert.ok(keys.length >= 20);
  keys.forEach((k) => assert.ok(S[k].en && S[k].es, k));
});

test("the screen opens the sheet with the message in an editable box, and the script is loaded", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8");
  assert.match(html, /<textarea id="loan-remind-text"/);
  assert.match(html, /<script src="loan-reminder\.js\?v=/);
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /getElementById\("loan-remind-text"\)\.value\.trim\(\)/, "what is sent is what the box holds (edits included)");
});

test("setFriendPhone remembers the number as text, clears it, and refuses a wrong one", () => {
  const rt = freshApp({ entries: 30 }).rt;
  assert.equal(rt.api("getMeta", {}).capabilities.friendPhone, true);
  const ana = rt.api("addFriend", { name: "Ana Test" });
  assert.equal(rt.api("setFriendPhone", { id: ana.id, phone: "+51 987 654 321" }).phone, "+51987654321");
  assert.equal(rt.rows("Friends").find((f) => f.id === ana.id).phone, "+51987654321");
  assert.equal(rt.api("getMeta", {}).friends.find((f) => f.id === ana.id).phone, "+51987654321", "the app's friends list carries it");
  assert.throws(() => rt.api("setFriendPhone", { id: ana.id, phone: "12" }), /doesn't look right/);
  assert.throws(() => rt.api("setFriendPhone", { id: "nope", phone: "+51987654321" }), /not found/i);
  assert.equal(rt.api("setFriendPhone", { id: ana.id, phone: "" }).phone, "");
  assert.equal(rt.rows("Friends").find((f) => f.id === ana.id).phone, "");
});
