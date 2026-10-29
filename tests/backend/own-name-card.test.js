// "Is this you?" — the app asks about a name on its FIRST sighting (OwnerNames.gs, slice C of the onboarding plans), the answer is
// remembered, a name that is the same person as a confirmed one is never asked about, and a transfer to an unknown person gets a quiet
// "Maybe yours?" while no name is confirmed. All names are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, today } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const doc = (...p) => fs.readFileSync(path.join(__dirname, "../..", ...p), "utf8");
const learn = (rt, found) => run(rt, `learnOwnNames_(${JSON.stringify(found)})`);
const names = (rt) => run(rt, "ownerNamesList_()");
const ask = (rt) => run(rt, "ownerNameAsk_()");
const answer = (rt, name, yes) => run(rt, `answerOwnName(${JSON.stringify({ name, yes })})`);
const meta = (rt) => rt.api("getMeta", {});

test("the first sighting is asked about at once, and nothing is confirmed until the person answers", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(ask(rt), "", "no name seen, nothing to ask");
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }]);
  assert.equal(ask(rt), "RAMOS TORRES EVA CARLA");
  assert.deepEqual(names(rt), [], "asked, not confirmed");
  assert.equal(meta(rt).ownNameAsk, "RAMOS TORRES EVA CARLA", "the app gets it with the rest of its data");
  assert.equal(meta(rt).capabilities.ownName, true);
});

test("✓ confirms the name at once, and nothing more is asked", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "stmt:1111" }]);
  const res = answer(rt, "RAMOS TORRES EVA CARLA", true);
  assert.deepEqual(res.names, ["RAMOS TORRES EVA CARLA"]);
  assert.equal(res.ask, "");
  assert.equal(run(rt, "isOwnFullName_('Eva Carla Ramos Torres')"), true, "the app now recognises it, in any word order");
  assert.equal(meta(rt).ownNameAsk, "");
});

test("✗ is remembered: not asked again, and not confirmed later by two documents, in any form of the name", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "LUNA VEGA PABLO", source: "stmt:1111" }]);
  const res = answer(rt, "LUNA VEGA PABLO", false);
  assert.equal(res.ask, "");
  assert.deepEqual(res.pending, [], "not listed as waiting either");
  learn(rt, [{ name: "LUNA VEGA PABLO", source: "stmt:2222" }, { name: "PABLO LUNA VEGA JOSE", source: "mail:bank@example.test" }]);
  assert.deepEqual(names(rt), [], "two more documents do not override the person's no");
  assert.equal(ask(rt), "", "and a longer form of the same name is not asked about");
});

test("a name that is the same person as a confirmed one gives no card (longer, shorter, any order)", () => {
  const { rt } = freshApp({ small: true });
  rt.api("saveOwnerNames", { names: ["Eva Carla Ramos Torres"] });
  learn(rt, [{ name: "RAMOS TORRES EVA", source: "stmt:1" }, { name: "EVA CARLA RAMOS TORRES DE LUNA", source: "stmt:2" }]);
  assert.equal(ask(rt), "", "shorter and longer forms of the typed name are not asked about");
});

test("a genuinely different name does get a card (a joint-account holder, a typo)", () => {
  const { rt } = freshApp({ small: true });
  rt.api("saveOwnerNames", { names: ["Eva Carla Ramos Torres"] });
  learn(rt, [{ name: "LUNA VEGA PABLO", source: "stmt:1" }]);
  assert.equal(ask(rt), "LUNA VEGA PABLO");
});

test("of several forms of one new name the longest is shown, and one answer settles all of them", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "EVA RAMOS", source: "stmt:1" }]);
  learn(rt, [{ name: "EVA CARLA RAMOS TORRES", source: "stmt:1" }]);   // the same document: still one source, so nothing is confirmed on its own
  assert.deepEqual(names(rt), []);
  assert.equal(ask(rt), "EVA CARLA RAMOS TORRES");
  answer(rt, "EVA CARLA RAMOS TORRES", true);
  assert.equal(ask(rt), "", "the shorter form is the same person, so it is not asked about either");
});

test("copies that already have their name never get a card for it", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "s1" }, { name: "RAMOS TORRES EVA CARLA", source: "s2" }]);
  assert.equal(names(rt).length, 1);
  assert.equal(ask(rt), "");
  learn(rt, [{ name: "EVA CARLA RAMOS", source: "s3" }]);
  assert.equal(ask(rt), "", "a form of a confirmed name is not asked about either");
});

test("removing a name in My names counts as 'not me'; typing it again clears that", () => {
  const { rt } = freshApp({ small: true });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "s1" }, { name: "RAMOS TORRES EVA CARLA", source: "s2" }]);
  rt.api("saveOwnerNames", { names: [] });
  learn(rt, [{ name: "RAMOS TORRES EVA CARLA", source: "s3" }, { name: "RAMOS TORRES EVA CARLA", source: "s4" }]);
  assert.deepEqual(names(rt), [], "not confirmed again");
  assert.equal(ask(rt), "", "and not asked about");
  rt.api("saveOwnerNames", { names: ["Eva Carla Ramos Torres"] });
  assert.deepEqual(names(rt), ["Eva Carla Ramos Torres"], "typing it is confirmed at once");
});

test("a bad answer is refused", () => {
  const { rt } = freshApp({ small: true });
  assert.throws(() => rt.run("answerOwnName({ name: 'Eva', yes: true })"), /full name/);
});

test("'Maybe yours?': only on a waiting e-mail expense whose description is a person's name, and only while no name is confirmed", () => {
  const { rt } = freshApp({ small: true });
  const add = (over) => {
    const e = { id: "my-" + Math.random().toString(36).slice(2, 8), type: "expense", date: today(), amount: 50, currency: "PEN", category_id: "", description: "Ana Lopez Ruiz",
      paid_by: "me", payment_method_id: "", status: "pending", source: "email", merchant: "", ...over };
    rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
    return e;
  };
  const person = add({}), shop = add({ description: "Plaza Vea", merchant: "plaza vea" }), typed = add({ source: "manual" }), categorised = add({ category_id: "cat-x" });
  const flags = () => Object.fromEntries(rt.api("listPendingEntries", {}).filter((e) => [person, shop, typed, categorised].some((x) => x.id === e.id)).map((e) => [e.id, !!e.maybe_own]));
  let f = flags();
  assert.equal(f[person.id], true);
  assert.equal(f[shop.id], false, "a shop name is not a person's");
  assert.equal(f[typed.id], false, "something the person typed is theirs, not a guess");
  assert.equal(f[categorised.id], false);
  answer(rt, "Eva Carla Ramos Torres", true);
  f = flags();
  assert.equal(f[person.id], false, "once a name is confirmed the app can tell, so the mark goes");
});

test("the screens: a Home card with ✓ / ✗, the name line in the welcome, and the hint in Needs review, in both languages", () => {
  const html = doc("docs", "index.html"), app = doc("docs", "app.js"), strings = doc("docs", "strings.js");
  assert.match(html, /id="own-name-card" hidden[\s\S]*id="own-name-yes"[\s\S]*id="own-name-no"/);
  assert.match(html, /id="wa-name-block" hidden[\s\S]*id="wa-name"/);
  assert.match(app, /meta\.capabilities\.ownName \? String\(meta\.ownNameAsk/, "an older backend never shows the card");
  assert.match(app, /callApi\("answerOwnName", \{ name, yes \}\)/);
  assert.match(app, /saveOwnerNames", \{ names: \[welcome_\.ownName\] \}/, "a name typed in the welcome is confirmed at once");
  assert.match(app, /welcome_\.ownName && [^\n]*await callApi\("saveOwnerNames"[\s\S]*setBusinessFeatures/, "saved before the welcome is marked answered");
  assert.match(app, /entry\.maybe_own \?/);
  for (const k of ["ownName.title", "ownName.hint", "ownName.yes", "ownName.no", "ownName.error", "wa.nameTitle", "wa.nameHint", "wa.namePlaceholder", "review.maybeYours"]) {
    assert.match(strings, new RegExp(`"${k.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), `${k} in both languages`);
  }
});
