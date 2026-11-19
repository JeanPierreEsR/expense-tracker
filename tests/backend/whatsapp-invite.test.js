// Invitation codes for the WhatsApp bot (owner's plan "WhatsApp invitation code", 2026-11-19): the owner's app makes a code
// from the friend's number; the friend types code + number and the copy marks itself (no hand-typed Settings row).
// Made-up numbers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function friendCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");   // made by the installer: a friend's copy
  rt.svc.props.set("WEB_APP_URL", "https://script.google.com/macros/s/FRIENDCOPY123/exec");
  return rt;
}
function ownerCopy() { return freshApp({ small: true }).rt; }

test("the owner's copy makes the code; a friend's copy cannot", () => {
  const owner = ownerCopy();
  assert.equal(owner.run("getCapabilities_().whatsappInviteMake"), true);
  const inv = owner.api("makeWhatsAppInvite", { number: "+51 922 222 222" });
  assert.equal(inv.number, "51922222222");
  assert.match(inv.code, /^WA-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(owner.api("makeWhatsAppInvite", { number: "51922222222" }).code, inv.code, "the same number always gives the same code");
  assert.notEqual(owner.api("makeWhatsAppInvite", { number: "51933333333" }).code, inv.code);
  assert.throws(() => owner.api("makeWhatsAppInvite", { number: "12" }), /country code/);
  const friend = friendCopy();
  assert.equal(friend.run("getCapabilities_().whatsappInviteMake"), false);
  assert.equal(friend.run("getCapabilities_().whatsappInvite"), true);
  assert.throws(() => friend.api("makeWhatsAppInvite", { number: "51922222222" }));
});

test("the right code with its own number marks the copy and fills in the number; nothing else does", () => {
  const code = ownerCopy().api("makeWhatsAppInvite", { number: "51922222222" }).code;
  const rt = friendCopy();
  assert.throws(() => rt.api("useWhatsAppInvite", { code, number: "51933333333" }), /doesn't match/);
  assert.throws(() => rt.api("useWhatsAppInvite", { code: "WA-2222-2222", number: "51922222222" }), /doesn't match/);
  assert.throws(() => rt.api("useWhatsAppInvite", { code, number: "12" }), /country code/);
  assert.equal(rt.run("getCapabilities_().whatsappBot"), false, "refused codes change nothing");
  // Typed loosely (lower case, spaces instead of dashes) still counts.
  const r = rt.api("useWhatsAppInvite", { code: " " + code.toLowerCase().replace(/-/g, " ") + " ", number: "+51 922-222-222" });
  assert.equal(r.already, false);
  assert.equal(r.bot.offered, true);
  assert.equal(r.bot.on, false);
  assert.equal(r.bot.number, "51922222222", "the card opens with the number filled in");
  assert.equal(rt.run("getSettingsMap().whatsapp_offered"), "yes");
  assert.equal(rt.run("getCapabilities_().whatsappBot"), true);
  assert.equal(rt.run("getCapabilities_().whatsappBotOn"), false, "marked, not turned on: the person turns it on herself");
  assert.equal(rt.api("useWhatsAppInvite", { code, number: "51922222222" }).already, true);
  assert.equal(rt.rows("Settings").filter((s) => s.key === "whatsapp_offered").length, 1, "one row, never two");
  // From there it is the usual: turn on → the relay code.
  assert.match(rt.api("turnOnWhatsAppBot", { number: "51922222222" }).code, /^WA1 51922222222 /);
});

test("the error text exists in both languages", () => {
  const rt = friendCopy();
  assert.match(rt.run("tr_('whatsappBot.inviteWrong')"), /doesn't match/);
  assert.match(rt.run("BACKEND_STRINGS_['whatsappBot.inviteWrong'].es"), /no coincide/);
});
