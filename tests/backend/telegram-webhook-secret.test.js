// Telegram webhook protection (2026-10-05): updates must carry a shared secret that
// only Telegram -> the Cloudflare Worker -> Apps Script know. Until the owner turns
// it on, behaviour is unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { freshApp, linkTelegram } = require("./helpers");

const S = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
let n = 5000;
const discardUpdate = (entryId, chat, secret) => {
  const body = { update_id: ++n, callback_query: { id: "cb" + n, data: "discard:" + entryId, message: { chat: { id: chat }, message_id: 7 } } };
  if (secret !== undefined) body.relay_secret = secret;
  return JSON.stringify(body);
};
const pendingId = (data) => data.entries.find((e) => e.status === "pending").id;
const exists = (rt, id) => !!rt.rows("Entries").find((e) => e.id === id);

test("with no secret configured, updates are accepted exactly as before", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const chat = linkTelegram(rt);
  const id = pendingId(data);
  rt.rawPost(discardUpdate(id, chat));
  assert.equal(exists(rt, id), false);
});

test("with a secret configured, an update without it is ignored", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const chat = linkTelegram(rt);
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  const id = pendingId(data);
  const res = rt.rawPost(discardUpdate(id, chat));
  assert.equal(exists(rt, id), true, "forged update did nothing");
  assert.equal(res.ok, false);
});

test("a wrong secret is ignored too", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const chat = linkTelegram(rt);
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  const id = pendingId(data);
  rt.rawPost(discardUpdate(id, chat, "not-the-secret"));
  assert.equal(exists(rt, id), true);
});

test("the right secret is accepted and the update is handled", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const chat = linkTelegram(rt);
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  const id = pendingId(data);
  rt.rawPost(discardUpdate(id, chat, S));
  assert.equal(exists(rt, id), false);
});

test("the web app's normal requests are unaffected by the webhook secret", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  assert.equal(rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} })).ok, true);
});

test("a burst of forged updates alerts the owner (counted like wrong access codes)", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const chat = linkTelegram(rt);
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  for (let i = 0; i < 10; i++) rt.rawPost(discardUpdate(pendingId(data), chat));
  const alerts = rt.svc.fetchLog.filter((f) => /wrong access-code attempts/.test(f.options.payload));
  assert.equal(alerts.length, 1);
});

// ---- the sheet menu --------------------------------------------------------------
test("'Protect the Telegram webhook' needs the relay URL first", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  rt.state.alertButton = "YES";
  rt.run("menuProtectTelegramWebhook()");
  assert.ok(!rt.svc.props.get("TELEGRAM_RELAY_SECRET"));
  assert.ok(rt.svc.uiLog.some((m) => /relay url/i.test(m)));
});

test("'Protect the Telegram webhook' asks first, then stores a secret, re-registers the webhook with it, and shows it once", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  rt.svc.props.set("TELEGRAM_RELAY_URL", "https://relay.example.workers.dev");

  rt.state.alertButton = "NO";
  rt.run("menuProtectTelegramWebhook()");
  assert.ok(!rt.svc.props.get("TELEGRAM_RELAY_SECRET"), "declined: nothing changes");

  rt.state.alertButton = "YES";
  rt.run("menuProtectTelegramWebhook()");
  const secret = rt.svc.props.get("TELEGRAM_RELAY_SECRET");
  assert.ok(secret && secret.length >= 32 && /^[A-Za-z0-9_-]+$/.test(secret), "Telegram only allows letters, digits, _ and -");
  const call = rt.svc.fetchLog.find((f) => /setWebhook/.test(f.url));
  const sent = JSON.parse(call.options.payload);
  assert.equal(sent.url, "https://relay.example.workers.dev");
  assert.equal(sent.secret_token, secret);
  assert.ok(rt.svc.uiLog.some((m) => m.includes(secret)), "the secret is shown so it can be pasted into Cloudflare");
});

test("re-running 'Enable instant Telegram replies' keeps the secret header", () => {
  const { rt } = freshApp({ entries: 100 });
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "t");
  rt.svc.props.set("TELEGRAM_RELAY_URL", "https://relay.example.workers.dev");
  rt.svc.props.set("TELEGRAM_RELAY_SECRET", S);
  rt.run("enableTelegramWebhook()");
  const sent = JSON.parse(rt.svc.fetchLog.find((f) => /setWebhook/.test(f.url)).options.payload);
  assert.equal(sent.secret_token, S);
});

// ---- the Cloudflare Worker itself ---------------------------------------------------
async function loadWorker() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "cloudflare-worker", "telegram-relay.js"), "utf8");
  const file = path.join(os.tmpdir(), "relay-under-test-" + process.pid + ".mjs");
  fs.writeFileSync(file, src);
  return (await import("file://" + file)).default;
}
const req = (body, headers = {}) => new Request("https://relay.example/", { method: "POST", body, headers });

test("Worker: with a secret set, a request without Telegram's header is NOT forwarded", async () => {
  const worker = await loadWorker();
  let forwarded = 0;
  global.fetch = async () => { forwarded++; return new Response('{"ok":true}'); };
  const res = await worker.fetch(req(JSON.stringify({ update_id: 1 })), { RELAY_SECRET: S });
  assert.equal(res.status, 200, "still a plain 200 so Telegram doesn't back off");
  assert.equal(forwarded, 0);
});

test("Worker: with the right header it forwards the update WITH the secret added", async () => {
  const worker = await loadWorker();
  let sentBody = null;
  global.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return new Response('{"ok":true}'); };
  await worker.fetch(req(JSON.stringify({ update_id: 42 }), { "X-Telegram-Bot-Api-Secret-Token": S }), { RELAY_SECRET: S });
  assert.equal(sentBody.update_id, 42);
  assert.equal(sentBody.relay_secret, S);
});

test("Worker: a wrong header is not forwarded", async () => {
  const worker = await loadWorker();
  let forwarded = 0;
  global.fetch = async () => { forwarded++; return new Response('{"ok":true}'); };
  await worker.fetch(req(JSON.stringify({ update_id: 1 }), { "X-Telegram-Bot-Api-Secret-Token": "nope" }), { RELAY_SECRET: S });
  assert.equal(forwarded, 0);
});

test("Worker: with NO secret set it behaves exactly as before (safe to paste first)", async () => {
  const worker = await loadWorker();
  let sentBody = null;
  global.fetch = async (url, opts) => { sentBody = opts.body; return new Response('{"ok":true}'); };
  await worker.fetch(req(JSON.stringify({ update_id: 7 })), {});
  assert.equal(JSON.parse(sentBody).update_id, 7);
  assert.equal(JSON.parse(sentBody).relay_secret, undefined);
});
