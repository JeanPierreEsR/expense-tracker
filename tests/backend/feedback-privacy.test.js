// More tab merge 4 (owner's design, 2026-11-03): Privacy, Help me improve the app, Send feedback to JP, Extra features and Delete everything became ONE
// row, "Feedback & privacy" (friends' copies only); Signed-in devices became a card of My profile. The pop-ups they opened are unchanged.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "../../docs");
const read = (f) => fs.readFileSync(path.join(DOCS, f), "utf8");
const html = read("index.html");
const app = read("app.js");
const strings = read("strings.js");
const STRINGS = require(path.join(DOCS, "strings.js"));
const serverStrings = fs.readFileSync(path.join(__dirname, "../../backend/Strings.gs"), "utf8");
const beta = fs.readFileSync(path.join(__dirname, "../../backend/BetaEvents.gs"), "utf8");

const fpScreen = () => html.slice(html.indexOf('id="screen-feedback-privacy"'), html.indexOf('id="screen-statements"'));

test("the screen has its five cards in the agreed order: feedback, what I share, extra features, how my data is treated, removing everything", () => {
  const s = fpScreen();
  const at = (id) => s.indexOf(id);
  const order = ['id="fp-feedback-btn"', 'id="privacy-change-btn"', 'id="fp-extras-btn"', 'data-i18n="privacy.intro"', 'id="fp-erase-btn"'].map(at);
  assert.ok(order.every((n) => n > 0), "every card is there");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal((s.match(/class="fp-card"/g) || []).length, 4, "the first card needs no divider; the other four are set off");
});

test("the privacy text sits on the screen and is not cut: every section of the old pop-up is there except the removal paragraph, which became its own card", () => {
  const s = fpScreen();
  ["privacy.intro", "privacy.liveTitle", "privacy.live", "privacy.readsTitle", "privacy.readsMail", "privacy.readsFiles", "privacy.agreeTitle", "privacy.agree",
    "privacy.sendTitle", "privacy.send", "privacy.neverTitle", "privacy.never", "privacy.otherTitle", "privacy.updates", "privacy.signin"].forEach((k) => assert.ok(s.includes(`data-i18n="${k}"`), k));
  assert.ok(!s.includes('data-i18n="privacy.removeTitle"') && s.includes('data-i18n="privacy.remove"'));
  assert.match(STRINGS["privacy.remove"].en, /^Tap \x22Delete everything\x22 below\./);
  assert.match(STRINGS["privacy.remove"].es, /^Toca \x22Eliminar todo\x22 abajo\./);
});

test("Extra features keeps its pop-up but loses the second 'Change what I share' (the What I share card is on the same screen)", () => {
  assert.ok(!html.includes('id="extras-share-btn"') && !html.includes("extras.shareBtn"));
  assert.ok(html.includes('id="extras-modal-backdrop"') && html.includes('id="extras-takeback-btn"'));
  assert.ok(!app.includes('"extras-share-btn"'));
});

test("My profile has a fourth card, Where I'm signed in, whose button opens the same devices pop-up; the More row is gone", () => {
  const prof = html.slice(html.indexOf('id="screen-my-profile"'), html.indexOf('id="screen-feedback-privacy"'));
  assert.ok(prof.includes('id="my-profile-devices-card"') && prof.includes('id="my-profile-devices-btn"'));
  assert.ok(prof.indexOf('id="my-profile-dates-card"') < prof.indexOf('id="my-profile-devices-card"'));
  assert.match(app, /my-profile-devices-btn"\)\.addEventListener\("click", openDevicesModal_\)/);
  assert.ok(html.includes('id="devices-modal-backdrop"'));
  assert.equal(STRINGS["prof.devicesHead"].en, "📱 Where I'm signed in");
});

test("the devices card is on every copy (the owner's too), because the owner has no Feedback & privacy row", () => {
  const prof = html.slice(html.indexOf('id="my-profile-devices-card"'), html.indexOf('id="screen-feedback-privacy"'));
  assert.ok(!/hidden/.test(prof.slice(0, prof.indexOf("</div>"))), "no hidden attribute on the card");
  assert.ok(!/devices-card"\)\.hidden/.test(app));
});

test("the beta screen list and tab memory know the new screen", () => {
  assert.match(beta, /feedback_privacy: 1/);
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"feedback-privacy"'));
});

test("no text sends the person to a row that no longer exists, in either language", () => {
  const all = strings + serverStrings;
  ["More → Extra features", "Más → Funciones extra", "More → Privacy", "Más → Privacidad", "More → Signed-in devices", "Más → Dispositivos con sesión iniciada",
    "More → Delete everything", "Más → Borrar todo", "More → Send feedback", "Más → Enviar comentarios", "More → Help me improve", "Más → Ayúdame a mejorar"].forEach((t) => assert.ok(!all.includes(t), t));
  assert.match(STRINGS["bankReady.needMail"].en, /More → Feedback & privacy → Extra features/);
  assert.match(STRINGS["bankReady.needMail"].es, /Más → Comentarios y privacidad → Funciones extra/);
  assert.match(STRINGS["mailHealth.problem.auth"].en, /More → Feedback & privacy → Extra features/);
  assert.match(STRINGS["mailHealth.problem.auth"].es, /Más → Comentarios y privacidad → Funciones extra/);
  assert.match(STRINGS["privacy.signin"].en, /More → My profile → Where I'm signed in/);
  assert.match(STRINGS["privacy.signin"].es, /Más → Mi perfil → Dónde tengo la sesión iniciada/);
  assert.match(STRINGS["tour.more.feedback"].en, /Feedback & privacy/);
  assert.match(STRINGS["tour.more.feedback"].es, /Comentarios y privacidad/);
  assert.match(STRINGS["tour.more.extras"].en, /^ There, \x22Extra features\x22/, "it follows the Feedback & privacy sentence");
  assert.match(serverStrings, /More → Feedback & privacy → Extra features/);
});

test("every new text exists in both languages", () => {
  ["more.feedbackPrivacy", "fp.title", "fp.feedbackHead", "fp.feedbackHint", "fp.feedbackBtn", "fp.shareHead", "fp.extrasHead", "fp.extrasHint", "fp.extrasBtn", "fp.dataHead",
    "fp.eraseHead", "prof.devicesHead", "prof.devicesHint", "prof.devicesBtn"].forEach((k) => {
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  });
  assert.equal(STRINGS["more.feedbackPrivacy"].en, "💬 Feedback & privacy");
  assert.equal(STRINGS["more.feedbackPrivacy"].es, "💬 Comentarios y privacidad");
  ["more.privacy", "more.perfShare", "more.feedback", "more.extras", "more.devices", "privacy.title", "privacy.choiceTitle"].forEach((k) => assert.ok(!(k in STRINGS), k + " went with its row"));
});
