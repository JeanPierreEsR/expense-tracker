// Stage 4b of the friends & family rollout: the welcome questions (language, date order, currencies) and
// "a copy made by the installer starts with no sample friends". Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("the owner's copy (no FEATURES) never asks the welcome questions", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("getMeta").capabilities.onboarding, false);
});

test("a copy made by the installer asks once, until the answers are saved", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.api("getMeta").capabilities.onboarding, true);
  rt.api("saveOnboarding", { language: "es", dateOrder: "dmy", currencies: ["usd", "EUR"] });
  const meta = rt.api("getMeta");
  assert.equal(meta.capabilities.onboarding, false);
  assert.equal(meta.settings.language, "es");
  assert.equal(meta.settings.date_format, "dmy");
  assert.equal(meta.settings.favorite_currencies, "PEN,USD,EUR");
  assert.equal(meta.settings.onboarded, "yes");
});

test("the chosen date order is what typed dates are read with", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.api("saveOnboarding", { language: "en", dateOrder: "mdy", currencies: [] });
  assert.equal(rt.run('parseTypedDate_("03/04/2026")'), "2026-03-04");
  rt.api("saveOnboarding", { language: "en", dateOrder: "dmy", currencies: [] });
  assert.equal(rt.run('parseTypedDate_("03/04/2026")'), "2026-04-03");
});

test("year-first is a choice too, and typed year-first dates are read as year, month, day", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  const r = rt.api("saveOnboarding", { language: "en", dateOrder: "ymd", currencies: [] });
  assert.equal(r.dateOrder, "ymd");
  assert.equal(rt.api("getMeta").settings.date_format, "ymd");
  assert.equal(rt.run('parseTypedDate_("2026/4/3")'), "2026-04-03");
  assert.equal(rt.run('parseTypedDate_("03/04/2026")'), "", "no guessing for a day/month-first date when year-first was chosen");
});

test("bad answers are ignored: soles first, no duplicates, only 3-letter codes, at most 5 chips", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  const r = rt.api("saveOnboarding", { language: "fr", dateOrder: "xyz", currencies: ["PEN", "usd", "USD", "??", "EURO", "ars", "mxn", "cop", "brl"] });
  assert.deepEqual(r.currencies, ["PEN", "USD", "ARS", "MXN", "COP"]);
  assert.equal(r.language, undefined);
  assert.equal(r.dateOrder, undefined);
  const meta = rt.api("getMeta");
  assert.equal(meta.settings.language, "en", "an unsupported language leaves the setting alone");
  assert.equal(meta.settings.date_format, undefined);
});

test("answering twice is harmless", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  rt.api("saveOnboarding", { language: "es", dateOrder: "dmy", currencies: ["USD"] });
  rt.api("saveOnboarding", { language: "en", dateOrder: "mdy", currencies: ["EUR"] });
  const s = rt.api("getMeta").settings;
  assert.equal(s.language, "en");
  assert.equal(s.favorite_currencies, "PEN,EUR");
  assert.equal(rt.rows("Settings").filter((r) => r.key === "onboarded").length, 1);
});

test("a copy made by the installer gets no sample friends; the owner's copy and tests still do", () => {
  const { rt } = freshApp({ small: true });
  rt.sheet("Friends").rows.length = 1;
  rt.svc.props.set("FEATURES", "base");
  rt.run("seedFriends()");
  assert.equal(rt.rows("Friends").length, 0);
  assert.deepEqual(rt.api("getMeta").friends, [], "the app still opens with no friends at all");
  rt.svc.props.delete("FEATURES");
  rt.run("seedFriends()");
  assert.equal(rt.rows("Friends").length, 3);
});
