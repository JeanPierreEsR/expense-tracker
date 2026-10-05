// Telegram linking and polling robustness (persona findings, 2026-10-05).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const startMsg = (rt, chatId, code, n) =>
  rt.rawPost(JSON.stringify({ update_id: 7000 + n, message: { message_id: n, chat: { id: chatId }, text: "/start " + code } }));
const linked = (rt) => rt.svc.props.get("TELEGRAM_CHAT_ID");

test("first /start with the right code links the chat", () => {
  const { rt } = freshApp();
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  startMsg(rt, 111, rt.ACCESS_CODE, 1);
  assert.equal(linked(rt), "111");
});

test("a /start from ANOTHER chat cannot take over an already-linked bot, even with the right code", () => {
  const { rt } = freshApp();
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  startMsg(rt, 111, rt.ACCESS_CODE, 1);
  startMsg(rt, 999, rt.ACCESS_CODE, 2);
  assert.equal(linked(rt), "111");
  const said = rt.svc.fetchLog.map((f) => f.options.payload).join(" ");
  assert.match(said, /already linked/i);
});

test("a wrong code never links", () => {
  const { rt } = freshApp();
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  startMsg(rt, 111, "wrong", 1);
  assert.ok(!linked(rt));
});

test("one bad Telegram update does not stop the rest of the batch", () => {
  const { rt } = freshApp();
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  let calls = 0;
  rt.state.fetchHandler = (url) => {
    if (/getUpdates/.test(url)) return { ok: true, result: [{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }] };
    return { ok: true, result: {} };
  };
  rt.run(`var __seen = []; handleTelegramUpdate_ = function (u) { __seen.push(u.update_id); if (u.update_id === 2) throw new Error('bad update'); };`);
  rt.run("pollTelegramUpdates()");
  assert.deepEqual(JSON.parse(rt.run("JSON.stringify(__seen)")), [1, 2, 3]);
});
