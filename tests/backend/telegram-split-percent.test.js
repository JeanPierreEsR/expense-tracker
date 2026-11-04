// Split replies to the bot: the number may come before or after the name, and may be a percentage
// ("split Ana 20", "split 20 Ana", "split Ana 50%", "split 50% Ana"); parts are still separated by commas.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  rt.run(`appendRowObject('Telegram Messages', { message_id: '700', entry_id: ${JSON.stringify(pending.id)}, created_at: 'x' });`);
  rt.run(`updateEntryFields(${JSON.stringify(pending.id)}, { amount: 80, currency: 'PEN' });`);
  let n = 0;
  const reply = (text) => rt.rawPost(JSON.stringify({ update_id: 6000 + (++n), message: { chat: { id: chat }, message_id: 900 + n, text, reply_to_message: { message_id: 700 } } }));
  const splits = () => rt.rows("Entry Splits").filter((s) => s.entry_id === pending.id).map((s) => [s.friend_id, Number(s.amount)]);
  return { data, reply, splits };
}

test("amount before or after the name", () => {
  const { data, reply, splits } = setup();
  const [a, b] = data.friends;
  reply(`split ${a.name} 20, ${b.name} 15`);
  assert.deepEqual(splits(), [[a.id, 20], [b.id, 15]]);
  reply(`split 20 ${a.name}, 15 ${b.name}`);
  assert.deepEqual(splits(), [[a.id, 20], [b.id, 15]]);
});

test("percentages, before or after the name, 100% included", () => {
  const { data, reply, splits } = setup();
  const [a, b] = data.friends;
  reply(`split ${a.name} 100%`);
  assert.deepEqual(splits(), [[a.id, 80]]);
  reply(`split 100% ${a.name}`);
  assert.deepEqual(splits(), [[a.id, 80]]);
  reply(`split ${a.name} 25%, 50% ${b.name}`);
  assert.deepEqual(splits(), [[a.id, 20], [b.id, 40]]);
  reply(`split ${a.name} 50 %`);
  assert.deepEqual(splits(), [[a.id, 40]]);
});

test("the owner's own share can be a percentage or come first; the rest is divided", () => {
  const { data, reply, splits } = setup();
  const [a] = data.friends;
  reply(`split ${a.name}, me 25%`);
  assert.deepEqual(splits(), [[a.id, 60]]);
  reply(`split 30 yo, ${a.name}`);
  assert.deepEqual(splits(), [[a.id, 50]]);
});

test("more than 100% in total is refused and leaves the split as it was", () => {
  const { data, reply, splits } = setup();
  const [a, b] = data.friends;
  reply(`split ${a.name} 20`);
  reply(`split ${a.name} 60%, ${b.name} 60%`);
  assert.deepEqual(splits(), [[a.id, 20]]);
});
