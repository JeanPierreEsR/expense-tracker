// The WhatsApp bot for friends (owner's plan "WhatsApp bot for friends (Mia first)", 2026-11-16): offered only on copies the
// owner marks; turned on in My profile with the person's number; a code for the relay; off closes the door. Made-up values.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const FRIEND_URL = "https://script.google.com/macros/s/FRIENDCOPY123/exec";

function friendCopy({ offered } = {}) {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");   // made by the installer: a friend's copy
  rt.svc.props.set("WEB_APP_URL", FRIEND_URL);
  if (offered) rt.run("setSetting_('whatsapp_offered', 'yes')");
  return rt;
}
const post = (rt, body) => { rt.ctx.__b = JSON.stringify(body); return JSON.parse(rt.run("doPost({ postData: { contents: __b } }).getContent()")); };

test("a friend's copy the owner did not mark: nothing offered, nothing can be turned on, the door stays shut", () => {
  const rt = friendCopy();
  assert.deepEqual(JSON.parse(JSON.stringify(rt.api("getWhatsAppBot"))), { offered: false });
  assert.equal(rt.run("getCapabilities_().whatsappBot"), false);
  assert.equal(rt.run("getCapabilities_().whatsappBotOn"), false);
  assert.throws(() => rt.api("turnOnWhatsAppBot", { number: "51911111111" }));
});

test("a marked copy: turn on with the number → its own key, WhatsApp as review bot, a code for the relay", () => {
  const rt = friendCopy({ offered: true });
  assert.equal(rt.api("getWhatsAppBot").on, false);
  assert.throws(() => rt.api("turnOnWhatsAppBot", { number: "12" }), /country code/);
  const s = rt.api("turnOnWhatsAppBot", { number: "+51 911 111 111" });
  assert.equal(s.on, true);
  assert.equal(s.number, "51911111111");
  const key = rt.svc.props.get("WHATSAPP_RELAY_SECRET");
  assert.ok(key && key.length >= 24);
  assert.equal(s.code, `WA1 51911111111 ${FRIEND_URL} ${key}`);
  // The relay's own reading of that line (cloudflare-worker/whatsapp-relay.js) accepts it.
  assert.match(s.code, /^WA1\s+(\d{6,15})\s+(https:\/\/script\.google\.com\/\S+\/exec)\s+(\S{24,})$/);
  assert.equal(rt.svc.props.get("REVIEW_BOT"), "whatsapp");
  assert.equal(rt.run("reviewBotIsWhatsApp_()"), true);
  assert.equal(rt.run("getCapabilities_().whatsappBotOn"), true);
  // Turning on again keeps the same key (the owner's route stays valid).
  assert.equal(rt.api("turnOnWhatsAppBot", { number: "51911111111" }).code, s.code);
});

test("only the copy's own key opens its door; off closes it and puts the review bot back", () => {
  const rt = friendCopy({ offered: true });
  rt.api("turnOnWhatsAppBot", { number: "51911111111" });
  const key = rt.svc.props.get("WHATSAPP_RELAY_SECRET");
  rt.state.fetchHandler = (url) => (String(url).endsWith("/send") ? { messages: [{ id: "wamid.o1" }] } : { ok: true });
  const msg = (k) => post(rt, { whatsapp: { id: "wamid.i" + Math.random(), from: "51911111111", type: "text", text: "25 almuerzo" }, relay_secret: k });
  assert.equal(msg("owner-key-0123456789abcdefghijk").ok, false, "another copy's key is refused");
  assert.equal(msg(key).ok, true);
  assert.equal(rt.rows("Entries").filter((e) => e.source === "whatsapp").length, 1, "saved in this copy");
  const off = rt.api("turnOffWhatsAppBot");
  assert.equal(off.on, false);
  assert.equal(off.code, "");
  assert.ok(!rt.svc.props.get("REVIEW_BOT"), "the review bot setting is cleared");
  assert.equal(msg(key).ok, false, "off: the door is shut");
  assert.equal(rt.rows("Entries").filter((e) => e.source === "whatsapp").length, 1, "nothing deleted, nothing new");
});

test("the owner's copy: offered, and still on from the Sheet-menu setup (no change for him)", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", "test-relay-secret-0123456789abcdef");
  assert.equal(rt.run("whatsappOffered_()"), true);
  assert.equal(rt.run("whatsappBotOn_()"), true);
  assert.equal(rt.run("isWhatsAppRelayAuthorized_({ relay_secret: 'test-relay-secret-0123456789abcdef' })"), true);
});
