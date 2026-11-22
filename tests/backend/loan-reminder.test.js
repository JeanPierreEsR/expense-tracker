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
  assert.ok(text.includes("En total me debes S/ 70.00 (ya descontado lo que yo te debo)."));
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

test("the message can be written in the other language without changing the app's", () => {
  I18n.setLang("en");
  const loans = [loan({ direction: "they_owe_me", currency: "PEN", remaining: 85, description: "Cena", date: "2026-10-12" })];
  const es = R.build({ name: "Ana Test", today: "2026-11-02", loans, lang: "es" });
  assert.match(es, /^Hola Ana 👋/);
  assert.ok(es.includes("• Cena (12 oct): S/ 85.00"), "Spanish dates too");
  assert.ok(es.includes("En total me debes S/ 85.00."));
  assert.equal(I18n.getLang(), "en", "the app stays in English");
  assert.match(R.build({ name: "Ana", today: "2026-11-02", loans }), /^Hi Ana/);
});

test("the person's own template: tags in either language, filled in for each friend", () => {
  I18n.setLang("en");
  assert.equal(R.toEditable(R.defaultTemplate("es"), "es").includes("[Lista]"), true);
  assert.equal(R.fromEditable(R.toEditable(R.defaultTemplate("en"), "en")), R.defaultTemplate("en"), "round trip");
  const tpl = R.fromEditable("Oye [nombre], son [ Amount ] en total:\n[LIST]\nYapéame al 900 000 000 🙏");
  assert.equal(tpl, "Oye {name}, son {amount} en total:\n{list}\nYapéame al 900 000 000 🙏");
  const loans = [
    loan({ direction: "they_owe_me", currency: "PEN", remaining: 30, description: "Pizza", date: "2026-10-20" }),
    loan({ direction: "i_owe_them", currency: "PEN", remaining: 10 })
  ];
  const text = R.build({ name: "Bo Test", today: "2026-11-02", loans, lang: "es", template: tpl });
  assert.equal(text, "Oye Bo, son S/ 20.00 (ya descontado lo que yo te debo) en total:\n• Pizza (20 oct): S/ 30.00\nYapéame al 900 000 000 🙏");
  assert.match(R.build({ name: "Bo", today: "2026-11-02", loans, template: "  " }), /^Hi Bo/, "an empty template is the app's");
});

test("setFriendRemind keeps the number and the language; setReminderTemplate keeps one wording per language", () => {
  const rt = freshApp({ entries: 30 }).rt;
  assert.equal(rt.api("getMeta", {}).capabilities.remindTemplate, true);
  const ana = rt.api("addFriend", { name: "Ana Test" });
  let res = rt.api("setFriendRemind", { id: ana.id, lang: "es" });
  assert.equal(res.remind_lang, "es");
  assert.equal(res.phone, "");
  res = rt.api("setFriendRemind", { id: ana.id, phone: "+51 987 654 321" });
  assert.deepEqual([res.phone, res.remind_lang], ["+51987654321", "es"], "a field not sent is kept");
  const f = rt.api("getMeta", {}).friends.find((x) => x.id === ana.id);
  assert.deepEqual([f.phone, f.remind_lang], ["+51987654321", "es"], "the app's friends list carries both at once");
  assert.throws(() => rt.api("setFriendRemind", { id: ana.id, lang: "fr" }), /language/);
  assert.throws(() => rt.api("setFriendRemind", { id: ana.id, phone: "12", lang: "en" }), /doesn't look right/);
  assert.equal(rt.rows("Friends").find((x) => x.id === ana.id).remind_lang, "es", "a refused call changes nothing");
  assert.throws(() => rt.api("setFriendRemind", { id: "nope", lang: "en" }), /not found/i);

  rt.api("setReminderTemplate", { lang: "es", text: "Hola {name}, me debes {amount}." });
  assert.equal(rt.api("getMeta", {}).settings.remind_template_es, "Hola {name}, me debes {amount}.");
  assert.throws(() => rt.api("setReminderTemplate", { lang: "es", text: "Hola {name}" }), /\[List\]/);
  assert.throws(() => rt.api("setReminderTemplate", { lang: "de", text: "{list}" }), /language/);
  assert.throws(() => rt.api("setReminderTemplate", { lang: "en", text: "{list}" + "x".repeat(2000) }), /too long/);
  rt.api("setReminderTemplate", { lang: "es", text: "" });
  assert.equal(rt.api("getMeta", {}).settings.remind_template_es, "", "empty = back to the app's wording");
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

test("More → Friends: the number is listed, set when adding, changed or removed when editing; a wrong one changes nothing", () => {
  const rt = freshApp({ entries: 30 }).rt;
  assert.equal(rt.api("getMeta", {}).capabilities.friendPhoneEdit, true);
  const bo = rt.api("addFriend", { name: "Bo Test", phone: "+51 900 000 002" });
  assert.equal(bo.phone, "+51900000002");
  const listed = () => rt.api("listMyFriends", {}).find((f) => f.id === bo.id);
  assert.equal(listed().phone, "+51900000002");
  assert.equal(rt.api("updateFriend", { id: bo.id, name: "Bo Test", phone: "+51 900 000 003" }).phone, "+51900000003");
  assert.equal(listed().phone, "+51900000003");
  assert.equal(rt.api("updateFriend", { id: bo.id, name: "Bo Renamed" }).phone, "+51900000003", "a rename without `phone` keeps the number");
  assert.throws(() => rt.api("updateFriend", { id: bo.id, name: "Bo Other", phone: "12" }), /doesn't look right/);
  assert.equal(listed().name, "Bo Renamed", "the refused edit did not rename either");
  assert.equal(rt.api("updateFriend", { id: bo.id, name: "Bo Renamed", phone: "" }).phone, "");
  assert.equal(listed().phone, "");
  assert.throws(() => rt.api("addFriend", { name: "Cy Test", phone: "abc" }), /doesn't look right/);
  assert.ok(!rt.rows("Friends").some((f) => f.name === "Cy Test"), "a wrong number adds nobody");
});

test("a number typed by hand in the Sheet (Sheets dropped the '+') still reads as a number", () => {
  const rt = freshApp({ entries: 30 }).rt;
  const ana = rt.api("addFriend", { name: "Ana Test", phone: "+51900000004" });
  rt.run(`(function () { var s = getSheet('Friends'), h = getHeaders(s); setCellByRow_(s, h, findRowIndexById(s, h, '${ana.id}'), 'phone', 51900000005); })()`);
  assert.equal(rt.api("listMyFriends", {}).find((f) => f.id === ana.id).phone, "+51900000005");
});
