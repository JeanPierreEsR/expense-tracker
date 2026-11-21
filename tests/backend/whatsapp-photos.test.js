// Receipt photos on WhatsApp (2026-11-16): the same reader as Telegram (PhotoCapture.gs, the Mac Mini's Tesseract). A photo is
// queued as "wa:<media id>"; the Mac's getPhotoJob downloads it through the relay; the text it sends back becomes a waiting entry
// whose message comes on WhatsApp. Made-up values.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const SECRET = "test-relay-secret-0123456789abcdef";
const OWNER = "51900000000";
const PLIN = [
  "Pl interbank", "", "¡Plineaste!", "", "Ana Lo* C", "", "334 - Yape", "", "12.50 u", "",
  "05 Oct 2026 | 10:30 AM", "", "Código de operación: 01234567"
].join("\n");

function waApp({ friend } = {}) {
  const { rt } = freshApp({ small: true });
  if (friend) { rt.svc.props.set("FEATURES", "base"); rt.run("setSetting_('whatsapp_offered', 'yes')"); rt.svc.props.set("WHATSAPP_BOT", "on"); }
  rt.svc.props.set("WHATSAPP_RELAY_SECRET", SECRET);
  rt.svc.props.set("REVIEW_BOT", "whatsapp");
  rt.svc.props.set("WA_SWITCH_AT", "2999-01-01T00:00:00");
  const sent = [], mediaAsked = [];
  rt.state.fetchHandler = (url, opts) => {
    url = String(url);
    if (url.endsWith("/send")) { sent.push(JSON.parse(opts.payload).message); return { messages: [{ id: "wamid.out" + sent.length }] }; }
    if (url.endsWith("/media")) {
      assert.equal(opts.headers["X-Relay-Secret"], SECRET);
      const id = JSON.parse(opts.payload).id;
      mediaAsked.push(id);
      return id === "123456789" ? { mime: "image/jpeg", base64: Buffer.from("fake image bytes").toString("base64") } : { error: { message: "media not found" } };
    }
    return { ok: true };
  };
  let n = 0;
  const post = (msg) => {
    rt.ctx.__b = JSON.stringify({ whatsapp: Object.assign({ id: "wamid.in" + (++n), from: OWNER }, msg), relay_secret: SECRET });
    return JSON.parse(rt.run("doPost({ postData: { contents: __b } }).getContent()"));
  };
  const lastBody = () => { const m = sent[sent.length - 1]; return (m.text && m.text.body) || m.interactive.body.text; };
  return { rt, sent, mediaAsked, post, lastBody };
}

test("a receipt photo: queued for the Mac, downloaded through the relay, read into a waiting entry with its message", () => {
  const a = waApp();
  a.post({ type: "image", media_id: "123456789", mime: "image/jpeg", text: "" });
  assert.equal(a.lastBody(), a.rt.run("tr_('photo.queued')"));
  const job = a.rt.rows("Photo Jobs").pop();
  assert.equal(job.file_id, "wa:123456789");
  assert.equal(job.status, "queued");
  // The Mac's part: list, fetch, read, send the text back.
  assert.deepEqual(JSON.parse(JSON.stringify(a.rt.api("listPhotoJobs"))), [{ id: job.id }]);
  const img = a.rt.api("getPhotoJob", { id: job.id });
  assert.equal(img.mime, "image/jpeg");
  assert.equal(Buffer.from(img.base64, "base64").toString(), "fake image bytes");
  assert.deepEqual(a.mediaAsked, ["123456789"]);
  a.rt.api("submitPhotoJobText", { id: job.id, text: PLIN });
  const e = a.rt.rows("Entries").find((x) => x.source === "photo");
  assert.ok(e, "a waiting entry was made");
  assert.equal(e.status, "pending");
  assert.equal(Number(e.amount), 12.5);
  const card = a.sent[a.sent.length - 1];
  assert.ok(card.interactive && card.interactive.action.buttons.some((b) => b.reply.id === "confirm:" + e.id), "its message with Confirm · Edit · Discard came on WhatsApp");
  assert.equal(a.rt.rows("Telegram Messages").filter((m) => m.entry_id === e.id).length >= 1, true);
});

test("not a receipt: the same answer as Telegram, nothing saved", () => {
  const a = waApp();
  a.post({ type: "image", media_id: "123456789", text: "" });
  const job = a.rt.rows("Photo Jobs").pop();
  a.rt.api("getPhotoJob", { id: job.id });
  a.rt.api("submitPhotoJobText", { id: job.id, text: "a picture of a cat" });
  assert.equal(a.lastBody(), a.rt.run("tr_('photo.notAReceipt')"));
  assert.equal(a.rt.rows("Entries").filter((x) => x.source === "photo").length, 0);
});

test("a photo the relay cannot fetch any more: marked failed, the person is asked to send it again", () => {
  const a = waApp();
  a.post({ type: "image", media_id: "555555555", text: "" });
  const job = a.rt.rows("Photo Jobs").pop();
  assert.throws(() => a.rt.api("getPhotoJob", { id: job.id }));
  assert.equal(a.rt.rows("Photo Jobs").pop().status, "failed");
  assert.equal(a.lastBody(), a.rt.run("tr_('whatsapp.photoDownloadFailed')"));
});

test("a friend's copy with no photo reader says so and queues nothing", () => {
  const a = waApp({ friend: true });
  a.post({ type: "image", media_id: "123456789", text: "" });
  // A new person's first message: the answer comes first, then the bot's tour greets (BotTour.gs).
  const bodies = a.sent.map((m) => (m.text && m.text.body) || (m.interactive && m.interactive.body.text));
  assert.equal(bodies[0], a.rt.run("tr_('whatsapp.photoNoReader')"));
  assert.match(a.lastBody(), /tutorial|salir|"exit"/);
  assert.equal(a.rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Photo Jobs') ? getAllRows('Photo Jobs').length : 0"), 0, "nothing queued");
});

test("while Telegram is the review bot, a WhatsApp photo is not queued; the reply says where photos are read", () => {
  const a = waApp();
  a.rt.svc.props.delete("REVIEW_BOT");
  const res = a.post({ type: "image", media_id: "123456789", text: "" });
  assert.equal(res.data.reply, a.rt.run("tr_('whatsapp.photoNeedsBot')"));
  assert.equal(a.rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Photo Jobs') ? getAllRows('Photo Jobs').length : 0"), 0, "nothing queued");
});
