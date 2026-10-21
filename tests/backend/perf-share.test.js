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

// ---- the beta counts (a failed action's name + short code): a second outbox, the consent version, the daily limit ----

test("a second outbox with its own keys works like the first and the two never mix", () => {
  const st = fakeStorage();
  const timings = PerfShare.create(st);
  const beta = PerfShare.create(st, { outboxKey: "betaOutbox", seqKey: "betaSeq" });
  timings.append(call("getMeta"));
  beta.appendRaw({ t: 1, k: "error", n: "listEntries", d: "network", v: 1 });
  beta.appendRaw({ t: 2, k: "error", n: "createEntry", d: "unknown", v: 1 });
  assert.deepEqual(timings.peek(10).map((e) => e.s), [1]);
  const [a, b] = beta.peek(10);
  assert.deepEqual([a.s, b.s], [1, 2]);
  assert.equal(Object.keys(a)[0], "s", "the number goes first, which is what acknowledging relies on");
  assert.deepEqual([a.n, a.d], ["listEntries", "network"]);
  beta.ack(1);
  assert.deepEqual(beta.peek(10).map((e) => e.s), [2]);
  assert.equal(timings.peek(10).length, 1, "acknowledging one outbox leaves the other alone");
});

test("the beta counts are worth sending as soon as one waits (the timings need 30)", () => {
  const now = Date.now();
  const one = { count: 1, oldestT: now };
  assert.equal(PerfShare.shouldSend(one, now, 0, false), false);
  assert.equal(PerfShare.shouldSend(one, now, 0, false, 1), true);
  assert.equal(PerfShare.shouldSend(one, now, now - 3600000, false, 1), false, "still never more often than every 2 hours");
});

test("someone who agreed to speed only is asked again about the new part; 'not now' is respected three times; a no stays a no", () => {
  const ask = (state, owner = false) => PerfShare.needsAsk(state, owner);
  assert.equal(ask({}), true, "never asked");
  assert.equal(ask({ asked: true, on: true, scope: PerfShare.SCOPE }), false, "agreed to everything shown today");
  assert.equal(ask({ asked: true, on: true }), true, "agreed before the new part existed");
  assert.equal(ask({ asked: true, on: true, scopeSkips: 2 }), true);
  assert.equal(ask({ asked: true, on: true, scopeSkips: 3 }), false, "after three 'not now' it stays at what they agreed to");
  assert.equal(ask({ asked: true, on: false }), false, "a no is never asked again");
  assert.equal(ask({ asked: true, on: true }, true), false, "the owner's own phone is never asked");
  assert.equal(ask({}, true), false);
});

test("the error code is a plain lower-case word, never the message", () => {
  assert.equal(PerfShare.errorCode({ code: "invalid_access_code" }), "invalid_access_code");
  assert.equal(PerfShare.errorCode({ code: "Some Message 45.20" }), "unknown");
  assert.equal(PerfShare.errorCode({ message: "Amount 45.20 is not valid" }), "unknown");
  assert.equal(PerfShare.errorCode(null), "unknown");
  assert.equal(PerfShare.errorCode({ code: "x".repeat(60) }), "unknown");
});

test("one phone records at most 5 of the same error and 40 errors a day, then starts again the next day", () => {
  const st = fakeStorage();
  const day1 = Date.UTC(2026, 9, 21, 15, 0, 0);
  let ok = 0;
  for (let i = 0; i < 10; i++) if (PerfShare.shouldRecordError(st, "listEntries", "network", day1)) ok++;
  assert.equal(ok, 5, "the same broken screen cannot flood the outbox");
  let other = 0;
  for (let i = 0; i < 60; i++) if (PerfShare.shouldRecordError(st, "action" + i, "unknown", day1)) other++;
  assert.equal(other, 35, "40 a day in all (5 were already used)");
  assert.equal(PerfShare.shouldRecordError(st, "listEntries", "network", day1 + 86400000), true, "a new day starts fresh");
});

// ---- scope 3: what was done with a pending entry, weekly screen counts, the feedback text ----

test("the consent version is 3, and someone at version 2 is asked again about the newer parts", () => {
  assert.equal(PerfShare.SCOPE, 3);
  assert.equal(PerfShare.needsAsk({ asked: true, on: true, scope: 2 }, false), true);
  assert.equal(PerfShare.needsAsk({ asked: true, on: true, scope: 3 }, false), false);
  assert.equal(PerfShare.needsAsk({ asked: true, on: false, scope: 2 }, false), false, "a no stays a no");
});

test("bank names become the same slugs the backend knows", () => {
  assert.equal(PerfShare.bankSlug("BCP"), "bcp");
  assert.equal(PerfShare.bankSlug("Caja Piura"), "caja_piura");
  assert.equal(PerfShare.bankSlug("Scotiabank Perú"), "scotiabank_peru");
  assert.equal(PerfShare.bankSlug("  Banco de la Nación! "), "banco_de_la_nacion");
  assert.equal(PerfShare.bankSlug(null), "");
});

test("confirming an entry exactly as it came is 'confirmed', with no edited fields", () => {
  const entry = { type: "expense", category_id: "c1", amount: "45.20", description: "Cafe Luna", payment_method_id: "p1" };
  const fields = { description: "Cafe Luna", amount: 45.2, category_id: "c1" };
  assert.deepEqual(PerfShare.queueEvents(entry, fields, "bcp"), [{ k: "queue", n: "confirmed", d: "bcp", v: 1 }]);
});

test("each changed field is named, never its content", () => {
  const entry = { type: "expense", category_id: "c1", amount: "45.20", description: "Cafe Luna", payment_method_id: "p1" };
  const ev = PerfShare.queueEvents(entry, { description: "Cafe Luna Lima", amount: 50, category_id: "c2" }, "interbank");
  assert.deepEqual(ev.map((e) => [e.k, e.n]), [["queue", "edited"], ["queue_edit", "category"], ["queue_edit", "amount"], ["queue_edit", "description"]]);
  assert.ok(!JSON.stringify(ev).includes("Luna") && !JSON.stringify(ev).includes("50"));
});

test("choosing a category where the app had no guess is 'category_filled', not a wrong guess", () => {
  const ev = PerfShare.queueEvents({ type: "expense", category_id: "", amount: "10", description: "x" }, { description: "x", amount: 10, category_id: "c9" }, "no_account");
  assert.deepEqual(ev.map((e) => e.n), ["edited", "category_filled"]);
});

test("a withdrawal's amount is compared by size, and a changed account is an account edit", () => {
  const inv = PerfShare.queueEvents({ type: "investment", amount: "-100", description: "", payment_method_id: "p1", to_payment_method_id: "p2" }, { description: "", amount: -100, to_payment_method_id: "p2", payment_method_id: "p1" }, "bcp");
  assert.deepEqual(inv.map((e) => e.n), ["confirmed"]);
  const tr = PerfShare.queueEvents({ type: "transfer", amount: "5", description: "", payment_method_id: "", to_payment_method_id: "p2" }, { description: "", amount: 5, category_id: "c1", payment_method_id: "p1", to_payment_method_id: "p2" }, "bcp");
  assert.deepEqual(tr.map((e) => e.n), ["edited", "category_filled", "account"]);
});

test("discarding is one 'discarded' entry", () => {
  assert.deepEqual(PerfShare.queueEvents({ amount: "1" }, null, "yape"), [{ k: "queue", n: "discarded", d: "yape", v: 1 }]);
});

test("weeks follow the ISO calendar, Monday to Sunday", () => {
  assert.equal(PerfShare.weekKey(new Date(2026, 9, 19, 9).getTime()), "w2026_43");   // Monday
  assert.equal(PerfShare.weekKey(new Date(2026, 9, 25, 23).getTime()), "w2026_43");  // Sunday night
  assert.equal(PerfShare.weekKey(new Date(2026, 9, 26, 0, 5).getTime()), "w2026_44");
  assert.equal(PerfShare.weekKey(new Date(2027, 0, 3).getTime()), "w2026_53");
  assert.equal(PerfShare.screenName("screen-trip-detail"), "trip_detail");
});

test("screen openings are counted per week and handed over when the week ends", () => {
  const st = fakeStorage();
  const mon = new Date(2026, 9, 19, 9).getTime(), fri = new Date(2026, 9, 23, 9).getTime(), nextMon = new Date(2026, 9, 26, 9).getTime();
  assert.deepEqual(PerfShare.recordScreen(st, "overview", mon), []);
  PerfShare.recordScreen(st, "overview", mon + 1000);
  PerfShare.recordScreen(st, "loans", fri);
  const done = PerfShare.recordScreen(st, "entries", nextMon);
  assert.deepEqual(done.map((e) => [e.k, e.n, e.d, e.v]).sort(), [["screen", "loans", "w2026_43", 1], ["screen", "overview", "w2026_43", 2]]);
  assert.deepEqual(PerfShare.recordScreen(st, "entries", nextMon + 1000), [], "handed over only once");
  const later = PerfShare.recordScreen(st, null, new Date(2026, 10, 2).getTime());   // just closing a finished week
  assert.deepEqual(later.map((e) => [e.n, e.d, e.v]), [["entries", "w2026_44", 2]]);
});

test("a feedback note is cleaned exactly as the backend does it", () => {
  assert.equal(PerfShare.cleanFeedback("  mail ana.lo@example.com or 987 654 321, v0.10.1  "), "mail [email] or [number], v0.10.1");
  assert.equal(PerfShare.cleanFeedback("x".repeat(1500)).length, 1000);
  assert.equal(PerfShare.cleanFeedback(null), "");
});
