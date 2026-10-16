// The phone-side outbox for shared app-speed reports (docs/perf-share.js). Made-up entries only.
const test = require("node:test");
const assert = require("node:assert/strict");
const PerfShare = require("../../docs/perf-share.js");

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const call = (name = "listEntries", extra = {}) => ({ t: Date.now(), kind: "call", name, totalMs: 812.4, serverMs: 300, cold: false, attempts: 1, ok: true, ...extra });

test("entries get numbers that only go up, and keep just the timing fields", () => {
  const st = fakeStorage();
  const box = PerfShare.create(st);
  box.append(call("getMeta", { amount: 99, description: "lunch with Ana" }));
  box.append(call("listEntries"));
  const [a, b] = box.peek(10);
  assert.deepEqual([a.s, b.s], [1, 2]);
  assert.deepEqual(Object.keys(a).sort(), ["a", "c", "k", "n", "o", "s", "sm", "t", "tm"]);
  assert.equal(a.tm, 812);
  assert.ok(!st.getItem(PerfShare.OUTBOX_KEY).includes("lunch"));
});

test("a startup phase is kept as a startup entry", () => {
  const box = PerfShare.create(fakeStorage());
  box.append({ t: Date.now(), kind: "startup", name: "init:total", totalMs: 2500 });
  const [e] = box.peek(5);
  assert.equal(e.k, "startup");
  assert.equal(e.sm, null);
});

test("acknowledging deletes exactly the stored entries and keeps newer ones", () => {
  const box = PerfShare.create(fakeStorage());
  for (let i = 0; i < 10; i++) box.append(call("x" + i));
  box.ack(6);
  assert.deepEqual(box.peek(100).map((e) => e.s), [7, 8, 9, 10]);
  box.append(call("late"));            // arrives while a send was in flight
  box.ack(10);
  assert.deepEqual(box.peek(100).map((e) => e.s), [11]);
  box.ack(11);
  assert.equal(box.status().count, 0);
});

test("numbers keep growing after the outbox was emptied (so the backend never mistakes new entries for old)", () => {
  const box = PerfShare.create(fakeStorage());
  box.append(call()); box.append(call());
  box.ack(2);
  assert.equal(box.append(call()), 3);
});

test("peek returns at most the number asked, oldest first, and skips a damaged line", () => {
  const st = fakeStorage();
  const box = PerfShare.create(st);
  for (let i = 0; i < 5; i++) box.append(call());
  st.setItem(PerfShare.OUTBOX_KEY, st.getItem(PerfShare.OUTBOX_KEY).replace('"s":3', "{{garbage"));
  assert.deepEqual(box.peek(3).map((e) => e.s), [1, 2, 4]);
});

test("the outbox can never grow past its limit: the oldest entries go first", () => {
  const st = fakeStorage();
  const box = PerfShare.create(st);
  for (let i = 0; i < 6000; i++) box.append(call("listEntries"));
  assert.ok(st.getItem(PerfShare.OUTBOX_KEY).length <= PerfShare.MAX_CHARS);
  const all = box.peek(100000);
  assert.ok(all.length > 1500, "still holds a couple of thousand entries (" + all.length + ")");
  assert.equal(all[all.length - 1].s, 6000, "the newest entry is always kept");
  assert.ok(all[0].s > 1);
});

test("a full outbox is cheap: appending, counting and acknowledging stay fast", () => {
  const box = PerfShare.create(fakeStorage());
  for (let i = 0; i < 2000; i++) box.append(call("listEntries"));
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) box.append(call("listEntries"));
  const perAppendMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  t0 = process.hrtime.bigint();
  box.status(); box.peek(200); box.ack(box.peek(200)[199].s);
  const sendCycleMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(perAppendMs < 2, "append took " + perAppendMs.toFixed(3) + " ms");
  assert.ok(sendCycleMs < 50, "a send cycle took " + sendCycleMs.toFixed(1) + " ms");
});

test("when to send: enough entries, or the oldest has waited a day, and never too often", () => {
  const now = 1_000_000_000_000;
  const hr = 3600000;
  assert.equal(PerfShare.shouldSend({ count: 0, oldestT: 0 }, now, 0, false), false, "nothing to send");
  assert.equal(PerfShare.shouldSend({ count: 29, oldestT: now - hr }, now, 0, false), false, "too few, too recent");
  assert.equal(PerfShare.shouldSend({ count: 30, oldestT: now - hr }, now, 0, false), true, "enough entries");
  assert.equal(PerfShare.shouldSend({ count: 3, oldestT: now - 25 * hr }, now, 0, false), true, "a few, but a day old");
  assert.equal(PerfShare.shouldSend({ count: 500, oldestT: now - 25 * hr }, now, now - hr, false), false, "tried an hour ago");
  assert.equal(PerfShare.shouldSend({ count: 500, oldestT: now - 25 * hr }, now, now - 3 * hr, false), true);
  assert.equal(PerfShare.shouldSend({ count: 500, oldestT: now - 25 * hr }, now, now - 20 * 60000, true), false, "after a failure: wait 30 min");
  assert.equal(PerfShare.shouldSend({ count: 500, oldestT: now - 25 * hr }, now, now - 40 * 60000, true), true);
});

test("the name is cleaned exactly like the backend does it", () => {
  assert.equal(PerfShare.cleanLabel("  Ana María  "), "Ana María");
  assert.equal(PerfShare.cleanLabel("=HYPERLINK(\"x\")"), "HYPERLINKx");
  assert.equal(PerfShare.cleanLabel("@@+-Luis"), "Luis");
  assert.equal(PerfShare.cleanLabel("x".repeat(80)).length, 30);
  assert.equal(PerfShare.cleanLabel(null), "");
});

test("phone type uses only the words the backend accepts", () => {
  assert.equal(PerfShare.deviceKind("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", true), "iPhone (home screen)");
  assert.equal(PerfShare.deviceKind("Mozilla/5.0 (Linux; Android 14)", false), "Android");
  assert.equal(PerfShare.deviceKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", false), "Mac");
  assert.equal(PerfShare.deviceKind("", false), "Other");
});
